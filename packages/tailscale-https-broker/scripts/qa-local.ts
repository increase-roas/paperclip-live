#!/usr/bin/env node

/**
 * Local broker QA without root, Tailscale, or a host install.
 *
 * Drives the real BrokerCore with an in-memory Tailscale Serve fake, a
 * temporary registry and the in-memory audit sink. It exercises the same
 * reserve -> expose -> list -> remove lifecycle the socket server uses, which
 * is enough to verify the core on a laptop.
 *
 * Run with:
 *   pnpm --filter @paperclipai/tailscale-https-broker qa:local
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MemoryAuditSink } from "../src/audit.js";
import { BrokerCore, type CliResult, type ListenerOwnership } from "../src/broker-core.js";
import { defaultIsAllowedPort } from "../src/port-policy.js";
import type { BrokerRequest, PeerCredentials } from "../src/types.js";

const HOST = "paperclip-dev.tail29c1aa.ts.net";
const BIN = "/usr/bin/tailscale";
const RUNTIME = "2af79bb1-ecc5-4410-8438-091be135a921";
const PEER: PeerCredentials = { uid: 999, gid: 987, pid: process.pid };

class FakeTailscale {
  ports = new Map<number, string>([[443, "http://127.0.0.1:3100"]]);

  run = (argv: string[]): CliResult => {
    const [, sub, first, second] = argv;
    if (sub === "serve" && first === "status") {
      return { code: 0, stdout: JSON.stringify(this.status()), stderr: "", timedOut: false };
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
    return { code: 2, stdout: "", stderr: "unknown command", timedOut: false };
  };

  private status() {
    const TCP: Record<string, unknown> = {};
    const Web: Record<string, unknown> = {};
    for (const [port, proxy] of this.ports) {
      TCP[String(port)] = { HTTPS: true };
      Web[`${HOST}:${port}`] = { Handlers: { "/": { Proxy: proxy } } };
    }
    return { TCP, Web };
  }
}

function createCore(registryPath: string, audit: MemoryAuditSink) {
  const fake = new FakeTailscale();
  const core = new BrokerCore({
    tailscaleBinPath: BIN,
    registryPath,
    auditSink: audit,
    peerPolicy: { allowedUids: new Set([999]), allowedGids: new Set([987]) },
    nodeIdentity: "local-qa-node",
    isAllowedPort: defaultIsAllowedPort,
    deps: {
      runTailscale: fake.run,
      verifyListenerOwnership: (): ListenerOwnership => ({
        present: true,
        loopbackOnly: true,
        ownerUidMatches: true,
        inodes: ["qa"],
      }),
      nowIso: () => new Date().toISOString(),
    },
  });
  return { core, fake };
}

const directory = mkdtempSync(join(tmpdir(), "paperclip-broker-qa-"));
const registryPath = join(directory, "registry.json");
const audit = new MemoryAuditSink();
const { core, fake } = createCore(registryPath, audit);

const reserve: BrokerRequest = {
  op: "reserve",
  requestId: "qa-reserve",
  runtimeId: RUNTIME,
  listeners: [{ purpose: "app", port: 42100 }],
};

try {
  const reserved = await core.handle(reserve, PEER);
  console.log("reserve:", JSON.stringify(reserved));

  if (reserved.ok && reserved.op === "reserve") {
    const exposed = await core.handle(
      { op: "expose", requestId: "qa-expose", runtimeId: RUNTIME, handle: reserved.handle },
      PEER,
    );
    console.log("expose:", JSON.stringify(exposed));

    const listed = await core.handle({ op: "list", requestId: "qa-list" }, PEER);
    console.log("list:", JSON.stringify(listed));

    const removed = await core.handle(
      { op: "remove", requestId: "qa-remove", runtimeId: RUNTIME, handle: reserved.handle },
      PEER,
    );
    console.log("remove:", JSON.stringify(removed));
    console.log("serve ports after remove:", [...fake.ports.keys()].join(","));
  }

  console.log("audit records:", audit.events.length);
  if (!reserve || audit.events.length === 0) process.exitCode = 1;
} finally {
  rmSync(directory, { recursive: true, force: true });
}
