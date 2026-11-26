export interface ProviderSecretField {
  key: string;
  label: string;
  placeholder?: string;
}

export interface ProviderSecretSpec {
  provider: string;
  label: string;
  /** OAuth callback path on the Gateway; the route prefixes the Gateway URL. */
  redirectPath?: string;
  fields: ProviderSecretField[];
}

export interface CloudflareSecretWriterOptions {
  apiToken?: string;
  accountId?: string;
  workerName?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const DEFAULT_CF_ACCOUNT_ID = "a3f549867f040e13df33e5bd18f785f4";
const DEFAULT_CF_WORKER_NAME = "increase-roas-oauth-gateway";
const DEFAULT_CF_API_BASE = "https://api.cloudflare.com/client/v4";
const DEFAULT_TIMEOUT_MS = 20_000;

// Strict allowlist of provider -> Cloudflare Worker encrypted secret bindings.
// Arbitrary secret names are rejected so Paperclip can only write known provider keys.
export const GATEWAY_PROVIDER_SECRETS: Record<string, ProviderSecretSpec> = {
  fireflies: {
    provider: "fireflies",
    label: "Fireflies",
    fields: [
      { key: "FIREFLIES_API_KEY", label: "Fireflies API Key", placeholder: "Paste Fireflies API key" },
    ],
  },
  quickbooks: {
    provider: "quickbooks",
    label: "QuickBooks Online",
    redirectPath: "/oauth/quickbooks/callback",
    fields: [
      { key: "QBO_CLIENT_ID", label: "QuickBooks Client ID", placeholder: "AB..." },
      { key: "QBO_CLIENT_SECRET", label: "QuickBooks Client Secret", placeholder: "Paste Client Secret" },
    ],
  },
  gmail: {
    provider: "gmail",
    label: "Gmail",
    redirectPath: "/oauth/gmail/callback",
    fields: [
      { key: "GOOGLE_OAUTH_CLIENT_ID", label: "Google OAuth Client ID", placeholder: "...apps.googleusercontent.com" },
      { key: "GOOGLE_OAUTH_CLIENT_SECRET", label: "Google OAuth Client Secret", placeholder: "GOCSPX-..." },
    ],
  },
  zoom: {
    provider: "zoom",
    label: "Zoom",
    redirectPath: "/oauth/zoom/callback",
    fields: [
      { key: "ZOOM_CLIENT_ID", label: "Zoom Client ID", placeholder: "Paste Zoom Client ID" },
      { key: "ZOOM_CLIENT_SECRET", label: "Zoom Client Secret", placeholder: "Paste Zoom Client Secret" },
    ],
  },
  tailscale: {
    provider: "tailscale",
    label: "Tailscale",
    fields: [
      { key: "TAILSCALE_API_KEY", label: "Tailscale API Key", placeholder: "tskey-api-..." },
    ],
  },
  braintrust: {
    provider: "braintrust",
    label: "Braintrust",
    fields: [
      { key: "BRAINTRUST_API_KEY", label: "Braintrust API Key", placeholder: "sk-..." },
    ],
  },
  slack: {
    provider: "slack",
    label: "Slack",
    fields: [
      { key: "SLACK_BOT_TOKEN", label: "Slack Bot Token", placeholder: "xoxb-..." },
    ],
  },
  github: {
    provider: "github",
    label: "GitHub",
    fields: [
      { key: "GITHUB_TOKEN", label: "GitHub Token", placeholder: "ghp_... or github_pat_..." },
    ],
  },
  elevenlabs: {
    provider: "elevenlabs",
    label: "ElevenLabs",
    fields: [
      { key: "ELEVENLABS_API_KEY", label: "ElevenLabs API Key", placeholder: "sk_..." },
    ],
  },
  hostinger: {
    provider: "hostinger",
    label: "Hostinger",
    fields: [
      { key: "HOSTINGER_API_TOKEN", label: "Hostinger API Token", placeholder: "Paste Hostinger API token" },
    ],
  },
};

// Reject ASCII control chars / newlines inside secret values
const MAX_SECRET_LENGTH = 4096;

function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

export function resolveCloudflareSecretConfig(opts?: CloudflareSecretWriterOptions) {
  const apiToken = (
    opts?.apiToken !== undefined
      ? opts.apiToken
      : (process.env.CLOUDFLARE_API_TOKEN ?? "")
  ).trim();
  const accountId = (
    opts?.accountId !== undefined
      ? opts.accountId
      : (process.env.CLOUDFLARE_ACCOUNT_ID ?? DEFAULT_CF_ACCOUNT_ID)
  ).trim();
  const workerName = (
    opts?.workerName !== undefined
      ? opts.workerName
      : (process.env.CLOUDFLARE_GATEWAY_WORKER_NAME ?? DEFAULT_CF_WORKER_NAME)
  ).trim();
  return {
    configured: Boolean(apiToken && accountId && workerName),
    apiToken,
    accountId,
    workerName,
  };
}

export function validateProviderSecretsPayload(
  provider: string,
  rawSecrets: unknown,
): { ok: true; entries: Array<[string, string]> } | { ok: false; error: string } {
  const spec = Object.hasOwn(GATEWAY_PROVIDER_SECRETS, provider)
    ? GATEWAY_PROVIDER_SECRETS[provider]
    : undefined;
  if (!spec) {
    return { ok: false, error: `Provider "${provider}" does not support direct secret binding.` };
  }
  if (!rawSecrets || typeof rawSecrets !== "object" || Array.isArray(rawSecrets)) {
    return { ok: false, error: "Request body must include a secrets object." };
  }

  const allowedKeys = new Set(spec.fields.map((f) => f.key));
  const entries: Array<[string, string]> = [];

  for (const [key, rawVal] of Object.entries(rawSecrets as Record<string, unknown>)) {
    if (!allowedKeys.has(key)) {
      return { ok: false, error: `Secret key "${key}" is not allowed for provider "${provider}".` };
    }
    if (typeof rawVal !== "string") {
      return { ok: false, error: `Secret value for "${key}" must be a string.` };
    }
    const trimmed = rawVal.trim();
    if (!trimmed) {
      return { ok: false, error: `Secret value for "${key}" cannot be empty.` };
    }
    if (trimmed.length > MAX_SECRET_LENGTH) {
      return { ok: false, error: `Secret value for "${key}" exceeds maximum length.` };
    }
    if (hasControlChar(trimmed)) {
      return { ok: false, error: `Secret value for "${key}" contains invalid control characters.` };
    }
    entries.push([key, trimmed]);
  }

  if (entries.length === 0) {
    return { ok: false, error: "Provide at least one secret value to save." };
  }

  return { ok: true, entries };
}

export async function putCloudflareWorkerSecrets(
  entries: Array<[string, string]>,
  opts?: CloudflareSecretWriterOptions,
): Promise<
  | { ok: true; updatedKeys: string[] }
  | { ok: false; status: number; error: string; updatedKeys: string[] }
> {
  const cfg = resolveCloudflareSecretConfig(opts);
  if (!cfg.configured) {
    return {
      ok: false,
      status: 503,
      error: "CLOUDFLARE_API_TOKEN is not configured on this Paperclip server.",
      updatedKeys: [],
    };
  }

  const fetchImpl = opts?.fetchImpl ?? fetch;
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const url = `${DEFAULT_CF_API_BASE}/accounts/${encodeURIComponent(cfg.accountId)}/workers/scripts/${encodeURIComponent(cfg.workerName)}/secrets`;
  const updatedKeys: string[] = [];

  for (const [name, text] of entries) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        method: "PUT",
        headers: {
          authorization: `Bearer ${cfg.apiToken}`,
          "content-type": "application/json",
          "user-agent": "paperclip-server/1.0",
        },
        body: JSON.stringify({ name, text, type: "secret_text" }),
        signal: controller.signal,
      });

      if (!response.ok) {
        let cfMessage = `Cloudflare API returned HTTP ${response.status} while binding ${name}.`;
        try {
          const parsed = (await response.json()) as {
            errors?: Array<{ message?: string; code?: number }>;
          };
          const firstMsg = parsed?.errors?.[0]?.message;
          if (typeof firstMsg === "string" && firstMsg.trim()) {
            cfMessage = `Cloudflare rejected ${name}: ${firstMsg.trim()}`;
          }
        } catch {
          // Ignore non-JSON upstream error body
        }
        return {
          ok: false,
          // Don't pass Cloudflare's 401/403 through as Paperclip's own auth status.
          status: 502,
          error: cfMessage,
          updatedKeys,
        };
      }
      updatedKeys.push(name);
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        return { ok: false, status: 504, error: `Timed out binding ${name} on Cloudflare.`, updatedKeys };
      }
      return {
        ok: false,
        status: 502,
        error: `Could not reach Cloudflare API while binding ${name}.`,
        updatedKeys,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  return { ok: true, updatedKeys };
}
