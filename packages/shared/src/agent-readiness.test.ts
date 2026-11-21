import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AGENT_READINESS_CHECKS,
  agentReadinessCheck,
  scoreReadinessLevel,
  scoreReadinessSubject,
  summarizeAgentReadiness,
  upsertAgentReadinessAttestationSchema,
  type ScorableReadinessCheck,
} from "./agent-readiness.js";

function check(overrides: Partial<ScorableReadinessCheck> & { level: number }): ScorableReadinessCheck {
  return {
    kind: "auto",
    severity: "standard",
    status: "pass",
    ...overrides,
  };
}

describe("scoreReadinessLevel", () => {
  it("passes at exactly 80% when no must-pass check failed", () => {
    const result = scoreReadinessLevel(7, [
      check({ level: 7 }),
      check({ level: 7 }),
      check({ level: 7 }),
      check({ level: 7 }),
      check({ level: 7, status: "fail" }),
    ]);
    expect(result.status).toBe("pass");
    expect(result.passed).toBe(4);
    expect(result.applicable).toBe(5);
    expect(result.passRate).toBe(0.8);
  });

  it("fails below 80%", () => {
    const result = scoreReadinessLevel(7, [
      check({ level: 7 }),
      check({ level: 7 }),
      check({ level: 7 }),
      check({ level: 7, status: "fail" }),
      check({ level: 7, status: "fail" }),
    ]);
    expect(result.status).toBe("fail");
    expect(result.mustPassFailed).toBe(false);
  });

  it("fails on a must-pass failure even when every other check passes", () => {
    const result = scoreReadinessLevel(2, [
      check({ level: 2, severity: "must_pass", status: "fail" }),
      check({ level: 2 }),
      check({ level: 2 }),
      check({ level: 2 }),
      check({ level: 2 }),
      check({ level: 2 }),
      check({ level: 2 }),
      check({ level: 2 }),
      check({ level: 2 }),
      check({ level: 2 }),
    ]);
    expect(result.status).toBe("fail");
    expect(result.mustPassFailed).toBe(true);
    expect(result.passRate).toBe(0.9);
  });

  it("marks a level unverified when a manual check is not attested", () => {
    const result = scoreReadinessLevel(10, [
      check({ level: 10 }),
      check({ level: 10, kind: "manual", status: "not_checked" }),
    ]);
    expect(result.status).toBe("unverified");
    expect(result.notChecked).toBe(1);
  });

  it("does not count skipped checks in the rate", () => {
    const result = scoreReadinessLevel(12, [
      check({ level: 12, status: "skipped" }),
      check({ level: 12 }),
    ]);
    expect(result.status).toBe("pass");
    expect(result.applicable).toBe(1);
  });

  it("skips a level with no applicable checks", () => {
    expect(scoreReadinessLevel(13, [check({ level: 1 })])).toMatchObject({
      status: "skipped",
      applicable: 0,
      passRate: 1,
    });
  });

  it("counts an un-run live must-pass check as unverified, not failed", () => {
    const result = scoreReadinessLevel(2, [
      check({ level: 2, kind: "live", severity: "must_pass", status: "not_checked" }),
      check({ level: 2 }),
    ]);
    expect(result.status).toBe("unverified");
    expect(result.mustPassFailed).toBe(false);
  });
});

describe("scoreReadinessSubject", () => {
  it("prioritizes blocked over attention and unverified", () => {
    const subject = scoreReadinessSubject(
      { subjectType: "agent", subjectId: "a", name: "A", provider: null },
      [
        check({ level: 2, severity: "must_pass", status: "fail" }),
        check({ level: 1, status: "fail" }),
        check({ level: 10, kind: "manual", status: "not_checked" }),
      ],
    );
    expect(subject.status).toBe("blocked");
  });

  it("returns attention when a level fails without a must-pass failure", () => {
    const subject = scoreReadinessSubject(
      { subjectType: "agent", subjectId: "a", name: "A", provider: null },
      [check({ level: 1, status: "fail" })],
    );
    expect(subject.status).toBe("attention");
  });

  it("returns unverified when all cleared levels still have unattested manual checks", () => {
    const subject = scoreReadinessSubject(
      { subjectType: "agent", subjectId: "a", name: "A", provider: null },
      [
        check({ level: 1 }),
        check({ level: 9, kind: "manual", status: "not_checked" }),
      ],
    );
    expect(subject.status).toBe("unverified");
  });

  it("returns ready when every applicable level passes", () => {
    const subject = scoreReadinessSubject(
      { subjectType: "agent", subjectId: "a", name: "A", provider: null },
      [check({ level: 1 }), check({ level: 2, severity: "must_pass" })],
    );
    expect(subject.status).toBe("ready");
  });
});

describe("summarizeAgentReadiness", () => {
  it("counts subjects and aggregates levels across subjects", () => {
    const ready = scoreReadinessSubject(
      { subjectType: "agent", subjectId: "a", name: "A", provider: null },
      [check({ level: 1 })],
    );
    const blocked = scoreReadinessSubject(
      { subjectType: "bot", subjectId: "b", name: "B", provider: "grok_bot" },
      [check({ level: 1, severity: "must_pass", status: "fail" })],
    );
    const summary = summarizeAgentReadiness([ready, blocked], [
      check({ level: 1 }),
      check({ level: 1, severity: "must_pass", status: "fail" }),
    ]);
    expect(summary.subjectCount).toBe(2);
    expect(summary.subjectCounts.ready).toBe(1);
    expect(summary.subjectCounts.blocked).toBe(1);
    expect(summary.levels.find((level) => level.level === 1)?.status).toBe("fail");
  });
});

describe("catalog", () => {
  it("includes each level and marks the required must-pass checks", () => {
    expect(new Set(AGENT_READINESS_CHECKS.map((check) => check.level)).size).toBe(13);
    expect(agentReadinessCheck("model.probe")).toMatchObject({ kind: "live", severity: "must_pass" });
    expect(agentReadinessCheck("runtime.hermes_profile")).toMatchObject({ kind: "auto", severity: "must_pass" });
    expect(agentReadinessCheck("memory.gbrain_connected")).toMatchObject({ kind: "auto", severity: "must_pass" });
    expect(agentReadinessCheck("company.gbrain")).toMatchObject({ severity: "must_pass" });
    expect(agentReadinessCheck("permissions.vault_secrets")).toMatchObject({ severity: "must_pass" });
    expect(agentReadinessCheck("tests.no_real_clients")).toMatchObject({ kind: "manual", severity: "must_pass" });
    expect(agentReadinessCheck("permissions.approval_policy")).toMatchObject({ severity: "must_pass" });
  });

  it("keeps the v1.4 checklist and the catalog in lockstep", () => {
    const checklist = readFileSync(
      new URL("../../../doc/agent-readiness/AGENT-READINESS-CHECKLIST.md", import.meta.url),
      "utf8",
    );
    const boxLines = checklist.split("\n").filter((line) => line.startsWith("- [ ] "));
    const ids = boxLines.map((line) => line.match(/`([a-z0-9_.]+)`\s*$/)?.[1] ?? null);
    expect(ids.every(Boolean)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    expect(boxLines.length).toBe(AGENT_READINESS_CHECKS.length);
    expect(new Set(ids)).toEqual(new Set(AGENT_READINESS_CHECKS.map((check) => check.id)));
  });

  it("uses only allowlisted fix actions", () => {
    const actions = new Set(AGENT_READINESS_CHECKS.flatMap((check) => check.fix ? [check.fix.action] : []));
    expect([...actions].sort()).toEqual([
      "create_test_task",
      "pause_agent",
      "resume_agent",
      "run_probe",
      "snapshot_config",
      "sync_skills",
    ]);
  });
});

describe("attestation schema", () => {
  const base = { subjectType: "agent" as const, subjectId: "agent-1", checkId: "tests.no_real_clients" };

  it("accepts an attestation that says what was checked", () => {
    expect(upsertAgentReadinessAttestationSchema.safeParse({
      ...base,
      note: "Checked the fixture task; no live clients.",
    }).success).toBe(true);
  });

  it("rejects an attestation without a note", () => {
    const missing = upsertAgentReadinessAttestationSchema.safeParse(base);
    expect(missing.success).toBe(false);
    const blank = upsertAgentReadinessAttestationSchema.safeParse({ ...base, note: "   " });
    expect(blank.success).toBe(false);
  });
});
