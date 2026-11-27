import {
  proofCheckAllowsClosure,
  requiredProofCheckFromLabels,
  type ProofChecksResponse,
} from "@paperclipai/shared/ir-system-map";
import { formatCheckName } from "../pages/system-map/systemMapHelpers";

export type ProofGateState =
  | { kind: "none" }
  | { kind: "loading"; key: string }
  | { kind: "hidden"; key: string }
  | { kind: "checked"; key: string; allowed: boolean; status: string; detail: string | null };

/**
 * What an operational issue's `proof:<check>` label means for closing it.
 * Mirrors the server guard: missing, failing, unknown, stale or unreachable
 * blocks Done. A viewer who may not read proof checks (403) sees the link but
 * not the status; the server still decides.
 */
export function proofGateState(input: {
  labels: ReadonlyArray<{ name: string }> | undefined;
  data: ProofChecksResponse | undefined;
  loading: boolean;
  errorStatus: number | null;
}): ProofGateState {
  const key = requiredProofCheckFromLabels(input.labels ?? []);
  if (!key) return { kind: "none" };
  if (input.errorStatus === 403) return { kind: "hidden", key };
  if (input.loading && !input.data) return { kind: "loading", key };
  const verdict = proofCheckAllowsClosure(key, input.data?.checks ?? null, input.data?.freshness ?? null);
  return { kind: "checked", key, allowed: verdict.allowed, status: verdict.status, detail: verdict.detail };
}

/** Status-picker entries to refuse while the gate is closed. */
export function proofGateDisabledStatuses(state: ProofGateState): Partial<Record<string, string>> | undefined {
  if (state.kind === "none" || state.kind === "hidden") return undefined;
  if (state.kind === "checked" && state.allowed) return undefined;
  const why = state.kind === "loading" ? "checking" : state.status;
  return { done: `Proof check "${formatCheckName(state.key)}" must pass before this issue can close (now: ${why}).` };
}
