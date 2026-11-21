import { and, eq, or, sql } from "drizzle-orm";
import {
  agents,
  toolApplications,
  toolConnectionInstalls,
  toolConnections,
  type Db,
} from "@paperclipai/db";
import { isHermesAdapter } from "./hermes-profile.js";

/**
 * GBrain is the team memory MCP server. A Hermes agent is expected to have it
 * attached from birth: the hire path records the attachment marker and installs
 * the company GBrain connector for the agent when that connector exists.
 */
export const GBRAIN_MCP_URL = "https://srv2155332.tailde26a1.ts.net/mcp";
export const GBRAIN_METADATA_KEY = "gbrain";

const HEALTHY = new Set(["healthy", "ok"]);
const PENDING = new Set(["unchecked", "unknown", "not_checked"]);

export interface GbrainMarker {
  url: string;
  attachedAt: string | null;
  mode: "connector" | "marker";
  connectionId: string | null;
}

export interface GbrainConnection {
  id: string;
  applicationKey: string | null;
  enabled: boolean;
  healthStatus: string | null;
}

export type GbrainSource = "connector" | "metadata" | "instructions" | null;

export interface GbrainAttachment {
  attached: boolean;
  source: GbrainSource;
  connectionId: string | null;
  healthStatus: string | null;
  healthy: boolean;
  pending: boolean;
  /** The hire marker exists but nothing is actually attached yet. */
  markerOnly: boolean;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function readGbrainMarker(metadata: unknown): GbrainMarker | null {
  const raw = asRecord(asRecord(metadata)[GBRAIN_METADATA_KEY]);
  if (!Object.keys(raw).length) return null;
  const url = typeof raw.url === "string" && raw.url.trim() ? raw.url.trim() : GBRAIN_MCP_URL;
  return {
    url,
    attachedAt: typeof raw.attachedAt === "string" ? raw.attachedAt : null,
    mode: raw.mode === "connector" ? "connector" : "marker",
    connectionId: typeof raw.connectionId === "string" ? raw.connectionId : null,
  };
}

/** Company tool connections that look like GBrain, matched by app key or config. */
export async function findGbrainConnections(db: Db, companyId: string): Promise<GbrainConnection[]> {
  const rows = await db.select({
    id: toolConnections.id,
    enabled: toolConnections.enabled,
    healthStatus: toolConnections.healthStatus,
    applicationKey: toolApplications.applicationKey,
  }).from(toolConnections)
    .leftJoin(toolApplications, eq(toolApplications.id, toolConnections.applicationId))
    .where(and(
      eq(toolConnections.companyId, companyId),
      or(
        sql`lower(coalesce(${toolApplications.applicationKey}, '')) like '%gbrain%'`,
        sql`${toolConnections.config}::text ilike '%gbrain%'`,
        sql`${toolConnections.config}::text ilike '%srv2155332.tailde26a1.ts.net/mcp%'`,
      ),
    ));
  return rows;
}

export function evaluateGbrainAttachment(input: {
  marker: GbrainMarker | null;
  connections: readonly GbrainConnection[];
  agentConnectionIds: readonly string[];
  instructionsMention: boolean;
}): GbrainAttachment {
  const byId = new Map(input.connections.map((connection) => [connection.id, connection]));
  const markerConnection = input.marker?.connectionId ? byId.get(input.marker.connectionId) ?? null : null;
  const markerAttached = Boolean(markerConnection?.enabled);
  const installed = input.connections.find((connection) =>
    connection.enabled && input.agentConnectionIds.includes(connection.id));
  const chosen = markerConnection ?? installed
    ?? input.connections.find((connection) => connection.enabled)
    ?? null;
  const source: GbrainSource = installed
    ? "connector"
    : input.instructionsMention
      ? "instructions"
      : input.marker
        ? "metadata"
        : null;
  // The hire marker records intent, not attachment: a marker naming an enabled
  // connector, an agent install or a profile entry counts.
  const attached = markerAttached || Boolean(installed) || input.instructionsMention;
  const healthStatus = chosen?.healthStatus ?? null;
  return {
    attached,
    source,
    connectionId: chosen?.id ?? null,
    healthStatus,
    healthy: Boolean(chosen) && HEALTHY.has(healthStatus ?? ""),
    pending: Boolean(chosen) && PENDING.has(healthStatus ?? ""),
    markerOnly: Boolean(input.marker) && !markerAttached && !installed && !input.instructionsMention,
  };
}

/**
 * Attach GBrain to a new Hermes agent. The marker is the durable record the
 * readiness check reads; the connector install is added when a company GBrain
 * connector exists so the agent can actually use it.
 */
export async function attachGbrainForAgent(
  db: Db,
  agent: {
    id: string;
    companyId: string;
    adapterType: string | null;
    metadata: unknown;
  },
): Promise<void> {
  if (!isHermesAdapter(agent.adapterType)) return;
  const connections = await findGbrainConnections(db, agent.companyId);
  const connection = connections.find((entry) => entry.enabled) ?? null;
  if (connection) {
    await db.insert(toolConnectionInstalls).values({
      companyId: agent.companyId,
      connectionId: connection.id,
      targetType: "agent",
      targetId: agent.id,
      createdByUserId: null,
    }).onConflictDoNothing();
  }
  const metadata = asRecord(agent.metadata);
  if (readGbrainMarker(metadata)) return;
  await db.update(agents).set({
    metadata: {
      ...metadata,
      [GBRAIN_METADATA_KEY]: {
        url: GBRAIN_MCP_URL,
        attachedAt: new Date().toISOString(),
        mode: connection ? "connector" : "marker",
        connectionId: connection?.id ?? null,
      },
    },
  }).where(and(eq(agents.id, agent.id), eq(agents.companyId, agent.companyId)));
}

export async function findAgentConnectionInstalls(db: Db, companyId: string, agentId: string): Promise<string[]> {
  const rows = await db.select({ connectionId: toolConnectionInstalls.connectionId })
    .from(toolConnectionInstalls)
    .where(and(
      eq(toolConnectionInstalls.companyId, companyId),
      eq(toolConnectionInstalls.targetType, "agent"),
      eq(toolConnectionInstalls.targetId, agentId),
    ));
  return rows.map((row) => row.connectionId);
}
