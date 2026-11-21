import { describe, expect, it } from "vitest";
import { evaluateNeonAdsAccess, evaluateNeonAppDatabase, safeDatabaseName, safeHostname } from "./neon.js";
import type { NeonConnection } from "./neon.js";

function credential(overrides: Partial<NeonConnection> = {}): NeonConnection {
  return {
    id: "conn-1",
    applicationKey: "neon",
    enabled: true,
    healthStatus: "healthy",
    database: "ads",
    readOnly: true,
    projectId: "paperclip",
    ...overrides,
  };
}

describe("evaluateNeonAppDatabase", () => {
  it("fails when the application database is embedded Postgres", () => {
    const result = evaluateNeonAppDatabase({
      mode: "embedded-postgres",
      embeddedPostgresPort: 54329,
    });
    expect(result.status).toBe("fail");
    expect(result.message).toContain("54329");
    expect(result.message).not.toContain("pass");
  });

  it("passes only on a Neon host, a direct migration URL and disabled prepared statements", () => {
    const result = evaluateNeonAppDatabase({
      mode: "postgres",
      databaseUrl: "postgres://user:secret@ep-cool-1-pooler.us-east-2.aws.neon.tech/paperclip",
      migrationUrl: "postgres://user:secret@ep-cool-1.us-east-2.aws.neon.tech/paperclip",
      preparedStatements: "false",
    });
    expect(result.status).toBe("pass");
    expect(result.evidence.neonHost).toBe(true);
    expect(result.evidence.migrationDirect).toBe(true);
    expect(JSON.stringify(result.evidence)).not.toContain("secret");
  });

  it("fails a pooled migration URL", () => {
    const result = evaluateNeonAppDatabase({
      mode: "postgres",
      databaseUrl: "postgres://user:secret@ep-cool-1-pooler.us-east-2.aws.neon.tech/paperclip",
      migrationUrl: "postgres://user:secret@ep-cool-1-pooler.us-east-2.aws.neon.tech/paperclip",
      preparedStatements: "false",
    });
    expect(result.status).toBe("fail");
    expect(result.message).toContain("migration");
  });

  it("parses hosts and database names without exposing credentials", () => {
    expect(safeHostname("postgres://u:p@db.example.com:5432/app")).toBe("db.example.com");
    expect(safeDatabaseName("postgres://u:p@db.example.com:5432/app")).toBe("app");
    expect(safeHostname("not a url")).toBeNull();
  });
});

describe("evaluateNeonAdsAccess", () => {
  it("stays unchecked when no Neon credential exists", () => {
    expect(evaluateNeonAdsAccess({ credentials: [], credentialInInstructions: false }).status).toBe("not_checked");
  });

  it("fails a credential that can write", () => {
    const result = evaluateNeonAdsAccess({
      credentials: [credential({ readOnly: false })],
      credentialInInstructions: false,
    });
    expect(result.status).toBe("fail");
    expect(result.message).toContain("read-only");
  });

  it("fails a credential aimed at the application database", () => {
    const result = evaluateNeonAdsAccess({
      credentials: [credential({ database: "paperclip" })],
      appDatabaseName: "paperclip",
      credentialInInstructions: false,
    });
    expect(result.status).toBe("fail");
    expect(result.message).toContain("application database");
  });

  it("fails a credential pasted into instructions", () => {
    const result = evaluateNeonAdsAccess({
      credentials: [credential()],
      appDatabaseName: "paperclip",
      credentialInInstructions: true,
    });
    expect(result.status).toBe("fail");
    expect(result.message).toContain("instruction");
  });

  it("passes only a read-only credential aimed at the ads database", () => {
    const result = evaluateNeonAdsAccess({
      credentials: [credential()],
      appDatabaseName: "paperclip",
      appDatabaseHost: "ep-cool-1-pooler.us-east-2.aws.neon.tech",
      credentialInInstructions: false,
    });
    expect(result.status).toBe("pass");
    expect(JSON.stringify(result.evidence)).not.toMatch(/postgres:\/\//);
  });

  it("stays unchecked when the database is unknown", () => {
    const result = evaluateNeonAdsAccess({
      credentials: [credential({ database: null })],
      credentialInInstructions: false,
    });
    expect(result.status).toBe("not_checked");
  });
});
