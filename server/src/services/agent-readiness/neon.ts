import { and, eq, or, sql } from "drizzle-orm";
import { toolApplications, toolConnections, type Db } from "@paperclipai/db";

/** Neon-specific readiness rules. Pure evaluators so they can be tested directly. */

export interface NeonConnection {
  id: string;
  applicationKey: string | null;
  enabled: boolean;
  healthStatus: string | null;
  database: string | null;
  readOnly: boolean | null;
  projectId: string | null;
}

export interface NeonCheckResult {
  status: "pass" | "fail" | "not_checked";
  message: string;
  evidence: Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function readBoolean(...values: unknown[]): boolean | null {
  for (const value of values) {
    if (typeof value === "boolean") return value;
    if (value === "true") return true;
    if (value === "false") return false;
  }
  return null;
}

export function safeHostname(value: string | undefined | null): string | null {
  if (!value) return null;
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function safeDatabaseName(value: string | undefined | null): string | null {
  if (!value) return null;
  try {
    const name = new URL(value).pathname.replace(/^\//, "").trim();
    return name || null;
  } catch {
    return null;
  }
}

function isNeonHost(host: string | null): boolean {
  return Boolean(host && (host.endsWith(".neon.tech") || host.endsWith(".neon.build")));
}

/**
 * Paperclip's application database must be Neon, reached directly for
 * migrations, with prepared statements disabled. The live instance is still
 * embedded Postgres today, which reports a clear failure rather than a pass.
 */
export function evaluateNeonAppDatabase(input: {
  mode: "postgres" | "embedded-postgres" | string;
  databaseUrl?: string | null;
  migrationUrl?: string | null;
  preparedStatements?: string | null;
  embeddedPostgresPort?: number | null;
}): NeonCheckResult {
  const appHost = safeHostname(input.databaseUrl);
  const migrationHost = safeHostname(input.migrationUrl);
  const neonHost = isNeonHost(appHost);
  const migrationDirect = Boolean(migrationHost && isNeonHost(migrationHost) && !migrationHost.includes("-pooler"));
  const preparedDisabled = input.preparedStatements === "false";
  const evidence = {
    mode: input.mode,
    embeddedPostgresPort: input.embeddedPostgresPort ?? null,
    neonHost,
    migrationDirect,
    preparedStatementsDisabled: preparedDisabled,
  };
  if (input.mode !== "postgres" || !appHost) {
    return {
      status: "fail",
      message: `Paperclip runs on embedded Postgres${input.embeddedPostgresPort ? ` (port ${input.embeddedPostgresPort})` : ""}, not Neon.`,
      evidence,
    };
  }
  if (!neonHost) {
    return { status: "fail", message: "The application database host is not a Neon host.", evidence };
  }
  if (!migrationDirect) {
    return {
      status: "fail",
      message: "The migration URL is missing, pooled, or not a Neon direct connection.",
      evidence,
    };
  }
  if (!preparedDisabled) {
    return { status: "fail", message: "DATABASE_PREPARED_STATEMENTS is not set to false for the pooled Neon host.", evidence };
  }
  return { status: "pass", message: "The application database is Neon with direct migrations and prepared statements disabled.", evidence };
}

/** Company Neon connections, matched by app key or configuration text. */
export async function findNeonConnections(db: Db, companyId: string): Promise<NeonConnection[]> {
  const rows = await db.select({
    id: toolConnections.id,
    applicationKey: toolApplications.applicationKey,
    enabled: toolConnections.enabled,
    healthStatus: toolConnections.healthStatus,
    config: toolConnections.config,
  }).from(toolConnections)
    .leftJoin(toolApplications, eq(toolApplications.id, toolConnections.applicationId))
    .where(and(
      eq(toolConnections.companyId, companyId),
      or(
        sql`lower(coalesce(${toolApplications.applicationKey}, '')) like '%neon%'`,
        sql`${toolConnections.config}::text ilike '%neon%'`,
      ),
    ));
  return rows.map((row) => {
    const config = asRecord(row.config);
    const methodConfig = asRecord(config.methodConfig);
    return {
      id: row.id,
      applicationKey: row.applicationKey,
      enabled: row.enabled,
      healthStatus: row.healthStatus,
      database: readString(config.database, config.databaseName, methodConfig.database, methodConfig.databaseName),
      readOnly: readBoolean(config.readOnly, methodConfig.readOnly),
      projectId: readString(config.projectId, methodConfig.projectId),
    };
  });
}

/**
 * Ad data lives in the Neon `ads` database, never in Paperclip's application
 * database. A credential that can write, points at the app database, or sits in
 * instructions fails; an unknown target stays unchecked rather than passing.
 */
export function evaluateNeonAdsAccess(input: {
  credentials: readonly NeonConnection[];
  appDatabaseName?: string | null;
  appDatabaseHost?: string | null;
  credentialInInstructions: boolean;
  neonMentionedInInstructions?: boolean;
}): NeonCheckResult {
  const appName = input.appDatabaseName?.toLowerCase() ?? null;
  const appHost = input.appDatabaseHost?.toLowerCase() ?? null;
  const evidence = {
    connections: input.credentials.map((credential) => ({
      id: credential.id,
      enabled: credential.enabled,
      database: credential.database,
      readOnly: credential.readOnly,
      healthStatus: credential.healthStatus,
    })),
    appDatabaseName: appName,
    credentialInInstructions: input.credentialInInstructions,
    neonMentionedInInstructions: Boolean(input.neonMentionedInInstructions),
  };
  const enabled = input.credentials.filter((credential) => credential.enabled);
  if (enabled.length === 0) {
    return { status: "not_checked", message: "No Neon credential is attached for ad data.", evidence };
  }
  if (input.credentialInInstructions) {
    return { status: "fail", message: "A Neon credential is written in an instruction file.", evidence };
  }
  const writes = enabled.filter((credential) => credential.readOnly !== true);
  if (writes.length) {
    return {
      status: "fail",
      message: `${writes.length} Neon credential${writes.length === 1 ? " is" : "s are"} not marked read-only.`,
      evidence,
    };
  }
  const pointsAtApp = enabled.filter((credential) =>
    (appName && credential.database?.toLowerCase() === appName)
    || (appHost && credential.database?.toLowerCase() === appHost));
  if (pointsAtApp.length) {
    return { status: "fail", message: "A Neon credential points at Paperclip's application database.", evidence };
  }
  const targeted = enabled.filter((credential) => credential.database?.toLowerCase() === "ads");
  if (targeted.length === 0) {
    return {
      status: "not_checked",
      message: "No attached Neon credential names the `ads` database.",
      evidence,
    };
  }
  return { status: "pass", message: "A read-only Neon credential targets the `ads` database.", evidence };
}
