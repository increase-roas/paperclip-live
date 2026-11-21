#!/usr/bin/env node
/**
 * Broker host entrypoint. Wires the tested BrokerCore to the live Tailscale
 * CLI, /proc listener-ownership check, file registry, file audit sink, and the
 * unix-socket transport. Runs as a dedicated, Tailscale-operator service
 * account — NOT as the Paperclip app/agent account.
 *
 * Usage:
 *   paperclip-tailscale-https-broker            # run the broker
 *   paperclip-tailscale-https-broker --doctor   # read-only preflight, no mutation
 *   paperclip-tailscale-https-broker --health   # machine-readable health probe
 */
import { FileAuditSink } from "./audit.js";
import { BrokerCore } from "./broker-core.js";
import { loadHostConfig } from "./config.js";
import { createNativePeerCredentialReader } from "./native-peercred.js";
import { createPeerResolver } from "./peercred.js";
import { defaultIsAllowedPort } from "./port-policy.js";
import { createProcListenerVerifier } from "./proc-listener.js";
import { startSocketServer } from "./socket-server.js";
import { buildStatusArgv } from "./argv.js";
import { assertPrimaryIntact, parseServeStatus } from "./serve-config.js";
import { createTailscaleRunner, isSupportedTailscaleVersion } from "./tailscale-cli.js";
import { brokerErrorTracker, brokerMetrics, brokerTailscaleCircuit, createBrokerLogger } from "./observability.js";

function runDoctor(): number {
  const config = loadHostConfig(process.env);
  const runner = createTailscaleRunner();
  const version = runner([config.tailscaleBinPath, "version"]);
  const versionOk = version.code === 0 && isSupportedTailscaleVersion(version.stdout);
  const status = runner(buildStatusArgv(config.tailscaleBinPath));
  let primaryOk = false;
  try {
    assertPrimaryIntact(parseServeStatus(JSON.parse(status.stdout)));
    primaryOk = true;
  } catch {
    primaryOk = false;
  }
  const checks = {
    tailscaleVersionSupported: versionOk,
    serveStatusReadable: status.code === 0,
    primaryRouteIntact: primaryOk,
    registryPathSafe: true, // loadHostConfig already threw otherwise
    nodeIdentity: config.nodeIdentity,
    // Echo the parsed protected set so an operator can confirm the preservation
    // list actually took effect before trusting it (PAP-17285).
    protectedPorts: config.protectedPorts,
    circuit: brokerTailscaleCircuit.snapshot(),
    metrics: brokerMetrics.snapshot(),
  };
  process.stdout.write(`${JSON.stringify(checks, null, 2)}\n`);
  return versionOk && status.code === 0 && primaryOk ? 0 : 1;
}

function runHealth(): number {
  const logger = createBrokerLogger();
  try {
    const config = loadHostConfig(process.env);
    const runner = createTailscaleRunner();
    const version = runner([config.tailscaleBinPath, "version"]);
    const versionOk = version.code === 0 && isSupportedTailscaleVersion(version.stdout);
    const health = {
      status: versionOk ? "ok" : "degraded",
      service: "paperclip-tailscale-https-broker",
      tailscaleVersionSupported: versionOk,
      socketPath: config.socketPath,
      registryPathSafe: true,
      circuit: brokerTailscaleCircuit.snapshot(),
      metrics: brokerMetrics.snapshot(),
    };
    process.stdout.write(`${JSON.stringify(health, null, 2)}\n`);
    logger.info("broker health check", { status: health.status });
    return versionOk ? 0 : 1;
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({
        status: "unhealthy",
        service: "paperclip-tailscale-https-broker",
        error: error instanceof Error ? error.message : String(error),
      }, null, 2)}\n`,
    );
    return 1;
  }
}

function main(): void {
  if (process.argv.includes("--doctor")) {
    process.exit(runDoctor());
  }
  if (process.argv.includes("--health")) {
    process.exit(runHealth());
  }

  const logger = createBrokerLogger();
  const config = loadHostConfig(process.env);
  const core = new BrokerCore({
    tailscaleBinPath: config.tailscaleBinPath,
    registryPath: config.registryPath,
    auditSink: new FileAuditSink(config.auditPath, true),
    peerPolicy: {
      allowedUids: new Set([config.serviceUid]),
      allowedGids: new Set([config.serviceGid]),
    },
    nodeIdentity: config.nodeIdentity,
    // Protected ports are excluded from the allocatable allowlist as well as
    // denied per-op, so a lane can never even reserve one (PAP-17285).
    isAllowedPort: (port) => defaultIsAllowedPort(port) && !config.protectedPorts.includes(port),
    protectedPorts: config.protectedPorts,
    deps: {
      runTailscale: createTailscaleRunner(),
      verifyListenerOwnership: createProcListenerVerifier(config.runtimeUid),
      nowIso: () => new Date().toISOString(),
    },
  });

  const server = startSocketServer({
    socketPath: config.socketPath,
    core,
    serviceUid: config.serviceUid,
    resolvePeer: createPeerResolver({
      soPeercred: createNativePeerCredentialReader(),
    }),
  });

  const shutdown = () => {
    logger.info("broker shutting down", { socketPath: config.socketPath });
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.stderr.write(`[broker] listening on ${config.socketPath}\n`);
}

try {
  main();
} catch (error) {
  brokerErrorTracker.capture(error, { surface: "broker", phase: "startup" });
  void brokerErrorTracker.flush(2_000);
  process.exitCode = 1;
}
