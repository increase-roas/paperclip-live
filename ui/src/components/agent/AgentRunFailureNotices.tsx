import { ProviderAuthReconnectNotice } from "./ProviderAuthReconnectNotice";
import { ResponsibleUserDenialNotice } from "@/components/ResponsibleUserDenialNotice";
import type { ResponsibleUserDenialCode } from "@paperclipai/shared";

export interface AgentRunFailureNoticesProps {
  run: {
    errorCode?: string | null;
    exitCode?: number | null;
    signal?: string | null;
  };
  adapterType: string;
  adapterConfig: Record<string, unknown> | null;
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
  responsibleDenialCode: ResponsibleUserDenialCode | null;
  responsibleUserName: string | null;
  hasNonZeroExit: boolean;
  providerAuthFailure: boolean;
}

/**
 * Provider-auth reconnect, responsible-user denial and non-zero exit notices for
 * one run. The agent page and the production variant render the same three.
 */
export function AgentRunFailureNotices({
  run,
  adapterType,
  adapterConfig,
  runtimeHref,
  login,
  result,
  responsibleDenialCode,
  responsibleUserName,
  hasNonZeroExit,
  providerAuthFailure,
}: AgentRunFailureNoticesProps) {
  return (
    <>
      {providerAuthFailure && (
        <ProviderAuthReconnectNotice
          adapterType={adapterType}
          adapterConfig={adapterConfig}
          runtimeHref={runtimeHref}
          login={login}
          result={result}
        />
      )}
      {responsibleDenialCode && (
        <ResponsibleUserDenialNotice code={responsibleDenialCode} userName={responsibleUserName} />
      )}
      {hasNonZeroExit && (
        <div className="text-xs text-red-600 dark:text-red-400">
          Exit code {run.exitCode}
          {run.signal && <span className="text-muted-foreground ml-1">(signal: {run.signal})</span>}
        </div>
      )}
    </>
  );
}
