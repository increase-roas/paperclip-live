/**
 * Read-only client for the OAuth gateway's owner-only bot pages API
 * (`/api/admin/bots`), described in the gateway's PAPERCLIP-BOTS-API.md.
 *
 * Two rules shape this module:
 *
 * 1. It is off unless an operator turns it on. Without the flag this returns a
 *    `disabled` result and makes no network call.
 * 2. The owner key lives only in the server environment. Nothing here logs it,
 *    returns it, or sends it to a browser, and error messages carry a status
 *    code and a short reason rather than the key or the request URL.
 */

import type {
  CompanyGatewayBotList,
  CompanyGatewayBotSummary,
  GatewayBotAuditEntry,
  GatewayBotKey,
  GatewayBotPolicy,
  GatewayBotSummary,
  GatewayBotUsageWindow,
  GatewayBotsState,
} from "@paperclipai/shared";

export type {
  CompanyGatewayBotList,
  CompanyGatewayBotSummary,
  GatewayBotAuditEntry,
  GatewayBotKey,
  GatewayBotPolicy,
  GatewayBotSummary,
  GatewayBotUsage,
  GatewayBotUsageWindow,
  GatewayBotsState,
} from "@paperclipai/shared";

export const GATEWAY_BOTS_FLAG_ENV = "PAPERCLIP_GATEWAY_BOTS_ENABLED";
export const GATEWAY_ADMIN_URL_ENV = "PAPERCLIP_GATEWAY_ADMIN_URL";
export const GATEWAY_ADMIN_KEY_ENV = "PAPERCLIP_GATEWAY_ADMIN_KEY";

/** How long a single gateway read may take before the page falls back politely. */
export const GATEWAY_BOTS_TIMEOUT_MS = 5_000;

export interface GatewayBotsClientOptions {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface GatewayBotsClient {
  enabled(): boolean;
  list(): Promise<CompanyGatewayBotList>;
  summary(agent: string): Promise<CompanyGatewayBotSummary>;
}

/** The flag is opt-in: unset, empty and "0"/"false"/"off" all mean off. */
export function gatewayBotsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env[GATEWAY_BOTS_FLAG_ENV] ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

export function gatewayBotNameIsValid(agent: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{1,31}$/.test(agent) && agent !== "alex-owner";
}

function stringOrNull(value: unknown, maxLength = 200): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : null;
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

function booleanOrFalse(value: unknown): boolean {
  return value === true;
}

function windowOf(value: unknown): GatewayBotUsageWindow {
  const record = (value ?? {}) as Record<string, unknown>;
  return { requests: numberOrZero(record.requests), errors: numberOrZero(record.errors) };
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string").slice(0, 50);
}

function keyOf(value: unknown): GatewayBotKey {
  const record = (value ?? {}) as Record<string, unknown>;
  return {
    present: booleanOrFalse(record.present),
    algorithm: stringOrNull(record.algorithm, 32),
    fingerprint: stringOrNull(record.fingerprint, 80),
    createdAt: stringOrNull(record.createdAt, 40),
    rotatedAt: stringOrNull(record.rotatedAt, 40),
    updatedAt: stringOrNull(record.updatedAt, 40),
  };
}

function policyOf(value: unknown): GatewayBotPolicy {
  const record = (value ?? {}) as Record<string, unknown>;
  return {
    mode: stringOrNull(record.mode, 60),
    allowDelete: booleanOrFalse(record.allowDelete),
    allowOutbound: booleanOrFalse(record.allowOutbound),
    allowAgencyWrite: booleanOrFalse(record.allowAgencyWrite),
    allowBulk: booleanOrFalse(record.allowBulk),
    allowSpend: booleanOrFalse(record.allowSpend),
    allowBuild: booleanOrFalse(record.allowBuild),
    outboundChannels: Array.isArray(record.outboundChannels) ? stringList(record.outboundChannels) : null,
    locations: stringOrNull(record.locations, 200),
    secrets: stringList(record.secrets),
    admin: booleanOrFalse(record.admin),
    role: stringOrNull(record.role, 60),
  };
}

function auditOf(value: unknown): GatewayBotAuditEntry[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 50).flatMap((entry) => {
    const record = (entry ?? {}) as Record<string, unknown>;
    const id = numberOrZero(record.id);
    const at = stringOrNull(record.at, 40);
    if (!id || !at) return [];
    return [
      {
        id,
        at,
        method: stringOrNull(record.method, 10) ?? "",
        path: stringOrNull(record.path, 300) ?? "",
        status: numberOrZero(record.status),
        ok: booleanOrFalse(record.ok),
        tokenType: stringOrNull(record.tokenType, 40),
        source: stringOrNull(record.source, 60),
        undoOf: typeof record.undoOf === "number" ? record.undoOf : null,
        undoneBy: typeof record.undoneBy === "number" ? record.undoneBy : null,
      },
    ];
  });
}

/**
 * Normalize one gateway summary. Unknown fields are dropped rather than passed
 * through, so a gateway change cannot put new values on a Paperclip page
 * without a matching change here.
 */
export function normalizeGatewayBotSummary(value: unknown): GatewayBotSummary | null {
  const record = (value ?? {}) as Record<string, unknown>;
  const agent = stringOrNull(record.agent, 32);
  if (!agent) return null;
  const preset = record.preset as Record<string, unknown> | null | undefined;
  const presetName = preset ? stringOrNull(preset.name, 60) : null;
  const providers =
    record.providers && typeof record.providers === "object" && !Array.isArray(record.providers)
      ? (record.providers as Record<string, unknown>)
      : {};
  const usage = (record.usage ?? {}) as Record<string, unknown>;
  return {
    agent,
    name: stringOrNull(record.name, 60) ?? agent,
    preset: presetName ? { name: presetName, description: preset ? stringOrNull(preset.description, 300) : null } : null,
    enabled: booleanOrFalse(record.enabled),
    hasKey: booleanOrFalse(record.hasKey),
    key: keyOf(record.key),
    providers,
    grantedProviders: stringList(record.grantedProviders),
    policy: policyOf(record.policy),
    usage: {
      last24h: windowOf(usage.last24h),
      last7d: windowOf(usage.last7d),
      lastUsedAt: stringOrNull(usage.lastUsedAt, 40),
    },
    audit: auditOf(record.audit),
    generatedAt: stringOrNull(record.generatedAt, 40),
  };
}

function describeFailure(status: number): { state: GatewayBotsState; message: string } {
  if (status === 401) {
    return { state: "unauthorized", message: "The gateway rejected the configured owner key." };
  }
  if (status === 403) {
    return { state: "unauthorized", message: "The gateway requires Alex's owner key for bot pages." };
  }
  if (status === 404) {
    return { state: "error", message: "The gateway has no bot pages API." };
  }
  if (status === 429) {
    return { state: "rate_limited", message: "The gateway admin rate limit is full. Try again shortly." };
  }
  return { state: "error", message: `The gateway answered ${status}.` };
}

export function createGatewayBotsClient(options: GatewayBotsClientOptions = {}): GatewayBotsClient {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? GATEWAY_BOTS_TIMEOUT_MS;
  const enabled = gatewayBotsEnabled(env);
  const baseUrl = (env[GATEWAY_ADMIN_URL_ENV] ?? "").trim().replace(/\/+$/, "");
  const key = (env[GATEWAY_ADMIN_KEY_ENV] ?? "").trim();

  async function read(path: string): Promise<
    { ok: true; body: unknown } | { ok: false; state: GatewayBotsState; message: string }
  > {
    if (!enabled) {
      return {
        ok: false,
        state: "disabled",
        message: `Gateway bot pages are off. Set ${GATEWAY_BOTS_FLAG_ENV}=true to read them.`,
      };
    }
    if (!baseUrl || !key) {
      return {
        ok: false,
        state: "not_configured",
        message: `Set ${GATEWAY_ADMIN_URL_ENV} and ${GATEWAY_ADMIN_KEY_ENV} on the server to read gateway bots.`,
      };
    }
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        method: "GET",
        headers: { authorization: `Bearer ${key}`, accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
        cache: "no-store",
      });
    } catch {
      return {
        ok: false,
        state: "unreachable",
        message: "The gateway did not answer. Its bot pages may be down; Paperclip keeps the roster from agent records.",
      };
    }
    if (!response.ok) return { ok: false, ...describeFailure(response.status) };
    try {
      return { ok: true, body: await response.json() };
    } catch {
      return { ok: false, state: "error", message: "The gateway returned a body that is not JSON." };
    }
  }

  return {
    enabled: () => enabled,
    async list() {
      const result = await read("/api/admin/bots");
      if (!result.ok) return { connected: false, state: result.state, message: result.message, bots: [] };
      const record = (result.body ?? {}) as Record<string, unknown>;
      const bots = Array.isArray(record.bots)
        ? record.bots.map(normalizeGatewayBotSummary).filter((bot): bot is GatewayBotSummary => bot !== null)
        : [];
      return {
        connected: true,
        generatedAt: stringOrNull(record.generatedAt, 40),
        count: bots.length,
        bots,
      };
    },
    async summary(agent: string) {
      if (!gatewayBotNameIsValid(agent)) {
        return { connected: false, state: "error", message: "That is not a gateway bot name." };
      }
      const result = await read(`/api/admin/bots/${encodeURIComponent(agent)}/summary`);
      if (!result.ok) return { connected: false, state: result.state, message: result.message };
      const summary = normalizeGatewayBotSummary(result.body);
      if (!summary) {
        return { connected: false, state: "error", message: "The gateway answered without a bot summary." };
      }
      return { connected: true, summary };
    },
  };
}
