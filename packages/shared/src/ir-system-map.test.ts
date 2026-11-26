import { describe, expect, it } from "vitest";
import {
  freshnessOf,
  proofCheckAllowsClosure,
  requiredProofCheckFromLabels,
  SYSTEM_MAP_STALE_AFTER_SECONDS,
} from "./ir-system-map.js";

const NOW = new Date("2026-11-26T18:00:00.000Z");

describe("freshnessOf", () => {
  it("reports age and turns stale past the threshold", () => {
    expect(freshnessOf("2026-11-26T17:55:00.000Z", NOW)).toMatchObject({ ageSeconds: 300, stale: false });
    const old = new Date(NOW.getTime() - (SYSTEM_MAP_STALE_AFTER_SECONDS + 1) * 1000).toISOString();
    expect(freshnessOf(old, NOW).stale).toBe(true);
  });

  it("treats a missing or invalid timestamp as stale", () => {
    expect(freshnessOf(null, NOW)).toMatchObject({ ageSeconds: null, stale: true });
    expect(freshnessOf("not-a-date", NOW).stale).toBe(true);
  });
});

describe("proof-gated closure", () => {
  const fresh = { stale: false };
  const checks = [
    { key: "gateway", status: "pass" as const, detail: null, observedAt: "2026-11-26T17:59:00Z" },
    { key: "db_feeds", status: "fail" as const, detail: "snapshots_fail:401", observedAt: "2026-11-26T17:59:00Z" },
  ];

  it("reads the proof check from a proof: label", () => {
    expect(requiredProofCheckFromLabels([{ name: "ops" }, { name: "Proof: Gateway " }])).toBe("gateway");
    expect(requiredProofCheckFromLabels([{ name: "ops" }])).toBeNull();
    expect(requiredProofCheckFromLabels([{ name: "proof:" }])).toBeNull();
  });

  it("allows closure only while the named check passes in a fresh snapshot", () => {
    expect(proofCheckAllowsClosure("gateway", checks, fresh)).toMatchObject({ allowed: true, status: "pass" });
    expect(proofCheckAllowsClosure("db_feeds", checks, fresh)).toMatchObject({ allowed: false, status: "fail" });
    expect(proofCheckAllowsClosure("crons", checks, fresh)).toMatchObject({ allowed: false, status: "missing" });
    expect(proofCheckAllowsClosure("gateway", checks, { stale: true })).toMatchObject({ allowed: false, status: "stale" });
    expect(proofCheckAllowsClosure("gateway", null, null)).toMatchObject({ allowed: false, status: "missing" });
  });
});
