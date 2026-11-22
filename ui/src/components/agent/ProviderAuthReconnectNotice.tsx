import { Link } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { providerAuthLabel } from "@/lib/provider-auth";

export interface ProviderAuthReconnectNoticeProps {
  adapterType: string;
  adapterConfig: Record<string, unknown> | null;
  /** Where the runtime tab lives for this agent variant. */
  runtimeHref: string;
  login: {
    mutate: () => void;
    isPending: boolean;
    isError: boolean;
    error: unknown;
  };
  result: {
    loginUrl?: string | null;
    stdout?: string | null;
    stderr?: string | null;
  } | null;
}

/**
 * Provider sign-in failure with the reconnect action and its output. Shared by
 * the current agent page and the production variant.
 */
export function ProviderAuthReconnectNotice({
  adapterType,
  adapterConfig,
  runtimeHref,
  login,
  result,
}: ProviderAuthReconnectNoticeProps) {
  return (
    <div className="space-y-2">
      {adapterType === "claude_local" ? (
        <Button
          variant="outline"
          size="sm"
          className="h-7 px-2 text-xs"
          onClick={() => login.mutate()}
          disabled={login.isPending}
        >
          {login.isPending ? "Running claude login..." : "Reconnect Claude"}
        </Button>
      ) : (
        <Button variant="outline" size="sm" className="h-7 px-2 text-xs" asChild>
          <Link to={runtimeHref}>Reconnect {providerAuthLabel({ adapterType, adapterConfig })}</Link>
        </Button>
      )}
      {login.isError && ( // query-error-ok: mutation result, not a query
        <p className="text-xs text-destructive">
          {login.error instanceof Error ? login.error.message : "Failed to run Claude login"}
        </p>
      )}
      {result?.loginUrl && (
        <p className="text-xs">
          Login URL:
          <a
            href={result.loginUrl}
            className="text-blue-600 underline underline-offset-2 ml-1 break-all dark:text-blue-400"
            target="_blank"
            rel="noreferrer"
          >
            {result.loginUrl}
          </a>
        </p>
      )}
      {result && (
        <>
          {!!result.stdout && (
            <pre className="bg-neutral-100 dark:bg-neutral-950 rounded-md p-3 text-xs font-mono text-foreground overflow-x-auto whitespace-pre-wrap">
              {result.stdout}
            </pre>
          )}
          {!!result.stderr && (
            <pre className="bg-neutral-100 dark:bg-neutral-950 rounded-md p-3 text-xs font-mono text-red-700 dark:text-red-300 overflow-x-auto whitespace-pre-wrap">
              {result.stderr}
            </pre>
          )}
        </>
      )}
    </div>
  );
}
