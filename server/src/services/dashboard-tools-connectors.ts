import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  chatGitHubConfigurations,
  plugins,
  toolApplications,
  toolConnections,
  toolInvocations,
} from "@paperclipai/db";
import type {
  DashboardConnectorRow,
  DashboardToolsConnectorsBoard,
} from "@paperclipai/shared";
import { adapterSettingsService } from "./adapter-settings.js";
import { retryIdempotentDatabaseOperation } from "../database-retry.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const EXPIRY_WARNING_DAYS = 14;

const ATTENTION_HEALTH = new Set(["degraded", "failed", "error", "missing_secret"]);

/** Root-level expiry keys that connectors and plugins are known to use. */
const EXPIRY_KEYS = ["expiresAt", "expires_at", "expiry", "tokenExpiresAt", "credentialExpiresAt"] as const;

export function daysUntil(expiresAt: Date, now: Date): number {
  return Number(((expiresAt.getTime() - now.getTime()) / DAY_MS).toFixed(2));
}

export function readExpiry(value: unknown): Date | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  for (const key of EXPIRY_KEYS) {
    const raw = record[key];
    if (typeof raw !== "string" && typeof raw !== "number" && !(raw instanceof Date)) continue;
    const parsed = raw instanceof Date ? raw : new Date(raw);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return null;
}

function classify(row: DashboardConnectorRow): "healthy" | "attention" | "unchecked" {
  if (row.health && ATTENTION_HEALTH.has(row.health)) return "attention";
  if (row.status === "error" || row.status === "failed") return "attention";
  if (!row.health || row.health === "unchecked" || row.health === "unknown" || row.status === "draft") {
    return "unchecked";
  }
  return "healthy";
}

export function dashboardToolsConnectorsService(db: Db) {
  return {
    async board(companyId: string, now = new Date()): Promise<DashboardToolsConnectorsBoard> {
      const pluginRows = await retryIdempotentDatabaseOperation(() =>
        db
          .select({
            id: plugins.id,
            name: plugins.packageName,
            pluginKey: plugins.pluginKey,
            version: plugins.version,
            status: plugins.status,
            lastError: plugins.lastError,
            updatedAt: plugins.updatedAt,
          })
          .from(plugins)
          .orderBy(plugins.pluginKey),
      );

      const connectionRows = await retryIdempotentDatabaseOperation(() =>
        db
          .select({
            id: toolConnections.id,
            name: toolConnections.name,
            transport: toolConnections.transport,
            authKind: toolConnections.authKind,
            status: toolConnections.status,
            healthStatus: toolConnections.healthStatus,
            healthMessage: toolConnections.healthMessage,
            healthCheckedAt: toolConnections.healthCheckedAt,
            lastHealthAt: toolConnections.lastHealthAt,
            config: toolConnections.config,
            applicationName: toolApplications.name,
            applicationType: toolApplications.type,
          })
          .from(toolConnections)
          .leftJoin(toolApplications, eq(toolConnections.applicationId, toolApplications.id))
          .where(eq(toolConnections.companyId, companyId))
          .orderBy(toolConnections.name),
      );

      const lastUseRows = await retryIdempotentDatabaseOperation(() =>
        db
          .select({
            connectionId: toolInvocations.connectionId,
            lastSuccessAt: sql<Date | string | null>`max(${toolInvocations.completedAt})`,
          })
          .from(toolInvocations)
          .where(and(eq(toolInvocations.companyId, companyId), eq(toolInvocations.status, "succeeded")))
          .groupBy(toolInvocations.connectionId),
      );

      const lastUseByConnection = new Map<string, Date>();
      for (const row of lastUseRows) {
        if (!row.connectionId || !row.lastSuccessAt) continue;
        const parsed = row.lastSuccessAt instanceof Date ? row.lastSuccessAt : new Date(row.lastSuccessAt);
        if (!Number.isNaN(parsed.getTime())) lastUseByConnection.set(row.connectionId, parsed);
      }

      const githubRows = await retryIdempotentDatabaseOperation(() =>
        db
          .select({
            endpointId: chatGitHubConfigurations.endpointId,
            configuration: chatGitHubConfigurations.configuration,
            updatedAt: chatGitHubConfigurations.updatedAt,
          })
          .from(chatGitHubConfigurations)
          .where(eq(chatGitHubConfigurations.companyId, companyId)),
      );

      const adapterRows = await retryIdempotentDatabaseOperation(() =>
        db
          .select({
            adapterType: agents.adapterType,
            count: sql<number>`count(*)::int`,
          })
          .from(agents)
          .where(eq(agents.companyId, companyId))
          .groupBy(agents.adapterType)
          .orderBy(agents.adapterType),
      );

      const disabledAdapters = new Set(await adapterSettingsService(db).getDisabledTypes());

      const items: DashboardConnectorRow[] = [];

      for (const plugin of pluginRows) {
        items.push({
          id: `plugin:${plugin.id}`,
          name: plugin.pluginKey,
          kind: "plugin",
          detail: `Plugin ${plugin.version}`,
          status: plugin.status,
          health: null,
          healthMessage: plugin.lastError,
          lastCheckAt: plugin.updatedAt.toISOString(),
          lastSuccessfulUseAt: null,
          expiresAt: null,
          expiryDaysRemaining: null,
        });
      }

      for (const connection of connectionRows) {
        const expiry = readExpiry(connection.config);
        items.push({
          id: `connection:${connection.id}`,
          name: connection.name,
          kind: "tool_connection",
          detail: [connection.applicationName ?? connection.applicationType, connection.transport, connection.authKind]
            .filter(Boolean)
            .join(" · "),
          status: connection.status,
          health: connection.healthStatus,
          healthMessage: connection.healthMessage,
          lastCheckAt: (connection.healthCheckedAt ?? connection.lastHealthAt)?.toISOString() ?? null,
          lastSuccessfulUseAt: lastUseByConnection.get(connection.id)?.toISOString() ?? null,
          expiresAt: expiry?.toISOString() ?? null,
          expiryDaysRemaining: expiry ? daysUntil(expiry, now) : null,
        });
      }

      for (const github of githubRows) {
        const repositoryCount = Object.keys(github.configuration?.repositories ?? {}).length;
        items.push({
          id: `github:${github.endpointId}`,
          name: "GitHub app",
          kind: "github_app",
          detail: `${repositoryCount} ${repositoryCount === 1 ? "repository" : "repositories"}`,
          status: github.configuration?.toolsEnabled ? "active" : "disabled",
          health: "unchecked",
          healthMessage: null,
          lastCheckAt: github.updatedAt.toISOString(),
          lastSuccessfulUseAt: null,
          expiresAt: null,
          expiryDaysRemaining: null,
        });
      }

      for (const adapter of adapterRows) {
        const disabled = disabledAdapters.has(adapter.adapterType);
        items.push({
          id: `adapter:${adapter.adapterType}`,
          name: adapter.adapterType,
          kind: "adapter",
          detail: `${Number(adapter.count)} ${Number(adapter.count) === 1 ? "agent" : "agents"}`,
          status: disabled ? "disabled" : "active",
          health: null,
          healthMessage: null,
          lastCheckAt: null,
          lastSuccessfulUseAt: null,
          expiresAt: null,
          expiryDaysRemaining: null,
        });
      }

      const classified = items.map((item) => ({ item, state: classify(item) }));

      return {
        companyId,
        generatedAt: now.toISOString(),
        items,
        summary: {
          total: items.length,
          healthy: classified.filter((entry) => entry.state === "healthy").length,
          needsAttention: classified.filter((entry) => entry.state === "attention").length,
          unchecked: classified.filter((entry) => entry.state === "unchecked").length,
          expiringWithin14Days: items.filter(
            (item) => item.expiryDaysRemaining !== null && item.expiryDaysRemaining <= EXPIRY_WARNING_DAYS,
          ).length,
          expiryUnknown: items.filter((item) => item.expiresAt === null).length,
        },
        notConnected: [],
      };
    },
  };
}
