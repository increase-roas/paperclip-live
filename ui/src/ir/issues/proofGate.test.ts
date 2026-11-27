import { describe, expect, it } from "vitest";
import type { ProofChecksResponse } from "@paperclipai/shared/ir-system-map";
import { proofGateDisabledStatuses, proofGateState } from "./proofGate";

const fresh = { observedAt: new Date().toISOString(), ageSeconds: 30, stale: false, thresholdSeconds: 900 };

function checks(status: "pass" | "fail"): ProofChecksResponse {
  return { checks: [{ key: "gateway", status, detail: status === "fail" ? "gateway_health_fail:502" : null, observedAt: fresh.observedAt }], freshness: fresh };
}

describe("proofGateState", () => {
  const labels = [{ name: "ops" }, { name: "proof:gateway" }];

  it("does nothing for issues without a proof label", () => {
    const state = proofGateState({ labels: [{ name: "ops" }], data: undefined, loading: false, errorStatus: null });
    expect(state).toEqual({ kind: "none" });
    expect(proofGateDisabledStatuses(state)).toBeUndefined();
  });

  it("disables Done while the check is loading, failing, missing or unreachable", () => {
    for (const state of [
      proofGateState({ labels, data: undefined, loading: true, errorStatus: null }),
      proofGateState({ labels, data: checks("fail"), loading: false, errorStatus: null }),
      proofGateState({ labels, data: { checks: [], freshness: fresh }, loading: false, errorStatus: null }),
      proofGateState({ labels, data: undefined, loading: false, errorStatus: 502 }),
      proofGateState({ labels, data: { ...checks("pass"), freshness: { ...fresh, stale: true } }, loading: false, errorStatus: null }),
    ]) {
      expect(proofGateDisabledStatuses(state)?.done).toMatch(/Proof check "OAuth Gateway" must pass/);
    }
  });

  it("enables Done once the check passes", () => {
    const state = proofGateState({ labels, data: checks("pass"), loading: false, errorStatus: null });
    expect(state).toMatchObject({ kind: "checked", allowed: true, status: "pass" });
    expect(proofGateDisabledStatuses(state)).toBeUndefined();
  });

  it("leaves the decision to the server for viewers who cannot read proof checks", () => {
    const state = proofGateState({ labels, data: undefined, loading: false, errorStatus: 403 });
    expect(state).toEqual({ kind: "hidden", key: "gateway" });
    expect(proofGateDisabledStatuses(state)).toBeUndefined();
  });
});
