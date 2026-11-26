import { useQuery } from "@tanstack/react-query";
import { ShieldCheck } from "lucide-react";
import { IrApiError, irSystemMapApi } from "../api/irOps";
import { HealthChip } from "../pages/system-map/HealthChip";
import { formatCheckName, type Tone } from "../pages/system-map/systemMapHelpers";
import { proofGateDisabledStatuses, proofGateState, type ProofGateState } from "./proofGate";

/** Live proof-gate state for an issue's `proof:<check>` label (queries only when one exists). */
export function useIssueProofGate(labels: ReadonlyArray<{ name: string }> | undefined): {
  state: ProofGateState;
  disabledStatuses: Partial<Record<string, string>> | undefined;
} {
  const hasProofLabel = proofGateState({ labels, data: undefined, loading: false, errorStatus: null }).kind !== "none";
  const query = useQuery({
    queryKey: ["ir", "proof-checks"],
    queryFn: irSystemMapApi.proofChecks,
    enabled: hasProofLabel,
    refetchInterval: hasProofLabel ? 60_000 : false,
    retry: false,
  });
  const errorStatus = query.error instanceof IrApiError ? query.error.status : query.error ? 0 : null;
  const state = proofGateState({ labels, data: query.data, loading: query.isLoading, errorStatus });
  return { state, disabledStatuses: proofGateDisabledStatuses(state) };
}

export function IssueProofCheckBadge({ state }: { state: ProofGateState }) {
  if (state.kind === "none") return null;
  let tone: Tone = "muted";
  let text = "checking…";
  const name = formatCheckName(state.key);
  let title = `Closing needs proof check "${name}" to pass.`;
  if (state.kind === "hidden") text = "status visible to instance admins";
  if (state.kind === "checked") {
    tone = state.allowed ? "ok" : "bad";
    text = state.allowed ? "passing" : state.status;
    if (state.detail) title = `${title} ${state.detail}`;
  }
  return (
    <span title={title} data-testid="issue-proof-check-badge">
      <HealthChip tone={tone}>
        <ShieldCheck className="size-3" />
        Proof: {name} · {text}
      </HealthChip>
    </span>
  );
}
