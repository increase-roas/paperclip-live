import { KeyRound } from "lucide-react";
import { Link } from "@/lib/router";
import { Button } from "./ui/button";
import { InlineBanner } from "./InlineBanner";

/** The agent-level recovery state for an expired or rejected provider sign-in. */
export function AgentAuthReconnectNotice({
  providerLabel,
  reconnectHref,
  onResume,
  resuming = false,
}: {
  providerLabel: string;
  reconnectHref: string;
  onResume?: () => void;
  resuming?: boolean;
}) {
  return (
    <div data-testid="agent-auth-reconnect" className="mt-2">
      <InlineBanner
        tone="warning"
        compact
        icon={KeyRound}
        title={`Reconnect ${providerLabel} to continue`}
        actions={
          <>
            <Button size="sm" variant="outline" asChild>
              <Link to={reconnectHref}>Reconnect {providerLabel}</Link>
            </Button>
            {onResume ? (
              <Button size="sm" variant="ghost" onClick={onResume} disabled={resuming}>
                {resuming ? "Resuming…" : "Resume agent"}
              </Button>
            ) : null}
          </>
        }
      >
        {providerLabel} sign-in expired or was rejected. Work stopped so runs do not fail in a loop.
        Reconnect {providerLabel}, then resume this agent.
      </InlineBanner>
    </div>
  );
}
