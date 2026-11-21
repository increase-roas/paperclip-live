import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { FileAuditSink } from "./audit.js";
import { BrokerCore, type CliResult, type ListenerOwnership } from "./broker-core.js";
import { defaultIsAllowedPort } from "./port-policy.js";
import type { BrokerRequest, PeerCredentials } from "./types.js";

const HOST = "paperclip-dev.tail29c1aa.ts.net";
const BIN = "/usr/bin/tailscale";
const RUNTIME = "2af79bb1-ecc5-4410-8438-091be135a921";
const PEER: PeerCredentials = { uid: 999, gid: 987, pid: 4242 };

/** In-memory Tailscale Serve fake; the same shape the real CLI returns. */
class FakeTailscale {
  ports = new Map<number, string>([[443, "http://127.0.0.1:3100"]]);

  run = (argv: string[]): CliResult => {
    const [, sub, first, second] = argv;
    if (sub === "serve" && first === "status") {
      return { code: 0, stdout: this.statusJson(), stderr: "", timedOut: false };
    }
    if (sub === "serve" && first === "--bg") {
      const port = Number(second.replace("--https=", ""));
      this.ports.set(port, `http://127.0.0.1:${port}`);
      return { code: 0, stdout: "", stderr: "", timedOut: false };
    }
    if (sub === "serve" && first.startsWith("--https=") && second === "off") {
      this.ports.delete(Number(first.replace("--https=", "")));
      return { code: 0, stdout: "", stderr: "", timedOut: false };
    }
    return { code: 2, stdout: "", stderr: "unknown", timedOut: false };
  };

  private statusJson(): string {
    const TCP: Record<string, unknown> = {};
    const Web: Record<string, unknown> = {};
    for (const [port, proxy] of this.ports) {
      TCP[String(port)] = { HTTPS: true };
      Web[`${HOST}:${port}`] = { Handlers: { "/": { Proxy: proxy } } };
    }
    return JSON.stringify({ TCP, Web });
  }
}

function makeCore(fake: FakeTailscale, registryPath: string, auditPath: string) {
  return new BrokerCore({
    tailscaleBinPath: BIN,
    registryPath,
    auditSink: new FileAuditSink(auditPath, true),
    peerPolicy: { allowedUids: new Set([999]), allowedGids: new Set([987]) },
    nodeIdentity: "node-1",
    isAllowedPort: defaultIsAllowedPort,
    deps: {
      runTailscale: fake.run,
      verifyListenerOwnership: (): ListenerOwnership => ({
        present: true,
        loopbackOnly: true,
        ownerUidMatches: true,
        inodes: ["5001"],
      }),
      nowIso: () => "2026-11-20T00:00:00.000Z",
    },
  });
}

const reserveRequest = (port = 42100): BrokerRequest => ({
  op: "reserve",
  requestId: "req-integration",
  runtimeId: RUNTIME,
  listeners: [{ purpose: "app", port }],
});

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("broker restart integration", () => {
  it("persists a lease, rehydrates it in a new core, and records audit trace ids", async () => {
    const directory = mkdtempSync(join(tmpdir(), "broker-integration-"));
    directories.push(directory);
    const registryPath = join(directory, "registry.json");
    const auditPath = join(directory, "audit.jsonl");

    const firstFake = new FakeTailscale();
    const first = makeCore(firstFake, registryPath, auditPath);
    const reserved = await first.handle(reserveRequest(), PEER);
    expect(reserved).toMatchObject({ ok: true, op: "reserve" });
    if (!reserved.ok || reserved.op !== "reserve") throw new Error("reserve failed");

    const exposed = await first.handle(
      { op: "expose", requestId: "req-expose", runtimeId: RUNTIME, handle: reserved.handle },
      PEER,
    );
    expect(exposed).toMatchObject({ ok: true, op: "expose" });

    const auditLines = readFileSync(auditPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(auditLines.length).toBeGreaterThanOrEqual(2);
    expect(auditLines.at(-1)).toMatchObject({
      op: "expose",
      runtimeId: RUNTIME,
      requestId: "req-expose",
      traceId: "req-expose",
      decision: "allow",
    });

    // A restarted broker reads the same registry and the persisted Serve state.
    const restartFake = new FakeTailscale();
    restartFake.ports = new Map(firstFake.ports);
    const restarted = makeCore(restartFake, registryPath, auditPath);
    const listed = await restarted.handle({ op: "list", requestId: "req-list" }, PEER);
    expect(listed).toMatchObject({
      ok: true,
      op: "list",
      listeners: [{ runtimeId: RUNTIME, purpose: "app", port: 42100 }],
    });

    const removed = await restarted.handle(
      { op: "remove", requestId: "req-remove", runtimeId: RUNTIME, handle: reserved.handle },
      PEER,
    );
    expect(removed).toMatchObject({ ok: true, op: "remove", removedPorts: [42100] });
    expect(restartFake.ports.has(42100)).toBe(false);
  });
});
