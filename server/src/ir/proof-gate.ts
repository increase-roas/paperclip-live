import { and, eq, inArray } from "drizzle-orm";
import { issueLabels, labels } from "@paperclipai/db";
import {
  proofCheckAllowsClosure,
  requiredProofChecksFromLabels,
} from "@paperclipai/shared/ir-system-map";
import { unprocessable } from "../errors.js";
import { cachedProofCheckSnapshot, type ProofCheckSnapshot } from "./system-map.js";

/**
 * Proof-gated closure for operational issues. An issue that carries a
 * `proof:<check>` label (for example `proof:gateway`) cannot move to `done`
 * until that ir-doctor check reports `pass` in a fresh snapshot. A missing,
 * failing, unknown or stale check is refused with 422. Every path that closes
 * an issue goes through `issueService.update`, which calls this first.
 */
export type ProofSnapshotReader = () => Promise<ProofCheckSnapshot | null>;

// Never a network call here: the caller may hold row locks. The refresher
// started with the routes keeps this cache warm.
let readSnapshot: ProofSnapshotReader = async () => cachedProofCheckSnapshot();

/** Test seam: swap the live feed reader. Returns a restore function. */
export function setProofSnapshotReaderForTests(reader: ProofSnapshotReader): () => void {
  const previous = readSnapshot;
  readSnapshot = reader;
  return () => {
    readSnapshot = previous;
  };
}

export async function assertIrProofGateAllowsTransition(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  dbOrTx: any,
  existing: { id: string; companyId: string; status: string },
  nextStatus: string | null | undefined,
  nextLabelIds?: readonly string[],
): Promise<void> {
  if (nextStatus !== "done" || existing.status === "done") return;
  const rows: Array<{ name: string }> = await dbOrTx
    .select({ name: labels.name })
    .from(issueLabels)
    .innerJoin(labels, eq(issueLabels.labelId, labels.id))
    .where(and(eq(issueLabels.issueId, existing.id), eq(labels.companyId, existing.companyId)));
  // A proof label added in the same update also gates this close.
  if (nextLabelIds && nextLabelIds.length > 0) {
    rows.push(
      ...(await dbOrTx
        .select({ name: labels.name })
        .from(labels)
        .where(and(inArray(labels.id, [...nextLabelIds]), eq(labels.companyId, existing.companyId)))),
    );
  }
  const requiredProofChecks = requiredProofChecksFromLabels(rows);
  if (requiredProofChecks.length === 0) return;
  const snapshot = await readSnapshot();
  for (const requiredProofCheck of requiredProofChecks) {
    const verdict = proofCheckAllowsClosure(requiredProofCheck, snapshot?.checks ?? null, snapshot?.freshness ?? null);
    if (verdict.allowed) continue;
    throw unprocessable(
      `This issue can close only after proof check "${requiredProofCheck}" passes (now: ${verdict.status}).`,
      {
        code: "ir_proof_check_not_passing",
        requiredProofCheck,
        proofStatus: verdict.status,
        detail: verdict.detail,
      },
    );
  }
}
