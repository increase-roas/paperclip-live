import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  companies,
  companyMemberships,
  connectionGrants,
  createDb,
  toolApplications,
  toolCatalogEntries,
  toolConnections,
  toolConnectionAppSnapshots,
  toolConnectionAppSyncs,
} from "@paperclipai/db";
import { toolAccessService } from "../services/tool-access.js";
import { AGGREGATOR_APP_SYNC_TTL_MS } from "@paperclipai/shared/aggregator-apps";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("aggregator app sweep", () => {
  let db: ReturnType<typeof createDb>;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-aggregator-sweep-");
    db = createDb(database.connectionString);
    cleanup = database.cleanup;
  }, 90_000);

  afterEach(async () => {
    // The sweep is company-agnostic, so each case starts from an empty queue.
    await db.delete(toolConnectionAppSnapshots);
    await db.delete(toolConnectionAppSyncs);
    await db.delete(toolCatalogEntries);
    await db.delete(connectionGrants);
    await db.delete(toolConnections);
    await db.delete(companyMemberships);
    await db.delete(toolApplications);
    await db.delete(companies);
  });

  afterAll(async () => {
    await cleanup?.();
  });

  const stale = () => new Date(Date.now() - 60 * 60_000);

  async function setup(count: number) {
    const [company] = await db
      .insert(companies)
      .values({ name: "Sweep backlog test", issuePrefix: randomUUID().slice(0, 6).toUpperCase() })
      .returning();
    const userId = randomUUID();
    await db.insert(companyMemberships).values({
      companyId: company.id,
      principalType: "user",
      principalId: userId,
      membershipRole: "admin",
      status: "active",
    });
    const [application] = await db
      .insert(toolApplications)
      .values({ companyId: company.id, applicationKey: randomUUID(), name: "Composio", type: "mcp_http", metadata: { sourceTemplateKey: "composio" } })
      .returning();
    const state = { fail: false };
    const connections = [];
    for (let index = 0; index < count; index += 1) {
      const [connection] = await db
        .insert(toolConnections)
        .values({
          companyId: company.id,
          applicationId: application.id,
          uid: randomUUID(),
          name: `Composio gateway ${index}`,
          transport: "mcp_remote",
          authKind: "none",
          credentialPolicy: "shared",
          status: "active",
          enabled: true,
          config: { sourceTemplateKey: "composio", url: "https://connect.composio.dev/mcp" },
        })
        .returning();
      await db.insert(connectionGrants).values({
        companyId: company.id,
        connectionId: connection.id,
        kind: "organization",
        status: "active",
        isDefault: true,
      });
      await db.insert(toolCatalogEntries).values({
        companyId: company.id,
        connectionId: connection.id,
        name: "COMPOSIO_MANAGE_CONNECTIONS",
        toolName: "COMPOSIO_MANAGE_CONNECTIONS",
        versionHash: "v1",
        status: "active",
        riskLevel: "read",
      });
      connections.push(connection);
    }
    const access = toolAccessService(db, {
      composioAppToolkits: ["gmail"],
      remoteHttpRequest: async (_url, init) => {
        if (state.fail) throw new Error("upstream unreachable");
        const rpc = init.body ? JSON.parse(String(init.body)) : {};
        const toolkits: { name: string }[] = rpc?.params?.arguments?.toolkits ?? [];
        return Response.json({
          jsonrpc: "2.0",
          id: rpc.id,
          result: { structuredContent: { results: toolkits.map((tool) => ({ toolkit: tool.name, accounts: [] })) } },
        });
      },
    });
    const actor = { actorType: "user" as const, actorId: userId };
    // Each gateway's credential key includes its grant id, so every row has to
    // come from that gateway's own sync.
    for (const connection of connections) {
      await access.syncComposioApps(connection.id, true, actor);
    }
    await vi.waitFor(
      async () => {
        const rows = await db.select().from(toolConnectionAppSyncs).where(eq(toolConnectionAppSyncs.companyId, company.id));
        expect(rows).toHaveLength(connections.length);
        expect(rows.every((row) => row.status === "ready")).toBe(true);
      },
      { timeout: 90_000, interval: 50 },
    );
    return { company, userId, connections, access, actor, state };
  }

  async function rowFor(connectionId: string) {
    const [row] = await db.select().from(toolConnectionAppSyncs).where(eq(toolConnectionAppSyncs.connectionId, connectionId));
    return row!;
  }

  it("clears a backlog larger than the old ten-row batch in one tick", async () => {
    const fixture = await setup(12);
    await db.update(toolConnectionAppSyncs).set({ lastCompletedAt: stale(), updatedAt: stale() });

    const result = await fixture.access.sweepAggregatorAppSyncs({ timeBudgetMs: 60_000 });

    expect(result).toMatchObject({ checked: 12, refreshed: 12, skipped: 0, batches: 1 });
    expect(result.failedConnectionIds).toEqual([]);
  }, 120_000);

  it("retires a rotated-credential row so it cannot starve the due list", async () => {
    const fixture = await setup(2);
    const [good, dead] = fixture.connections;
    const older = new Date(Date.now() - 2 * 60 * 60_000);
    // The dead row is the oldest and no longer matches the live credential.
    await db.update(toolConnectionAppSyncs).set({ lastCompletedAt: older, updatedAt: older, credentialKey: "rotated-away" })
      .where(eq(toolConnectionAppSyncs.connectionId, dead!.id));
    await db.update(toolConnectionAppSyncs).set({ lastCompletedAt: stale(), updatedAt: stale() })
      .where(eq(toolConnectionAppSyncs.connectionId, good!.id));

    const result = await fixture.access.sweepAggregatorAppSyncs({ limit: 1, timeBudgetMs: 60_000 });

    expect(result).toMatchObject({ checked: 2, refreshed: 1, skipped: 1, batches: 2 });
    expect(result.failedConnectionIds).toEqual([]);
    // The dead row is retired (no longer older than the window), so the next
    // tick does not pay for it again.
    expect((await rowFor(dead!.id)).lastCompletedAt!.getTime()).toBeGreaterThan(older.getTime());
    const next = await fixture.access.sweepAggregatorAppSyncs({ timeBudgetMs: 60_000 });
    expect(next).toMatchObject({ checked: 0 });
  }, 120_000);

  // The scheduler waits for this deadline instead of polling, so an instance
  // with nothing cached reports no deadline and issues no further queries.
  it("reports no deadline while nothing is cached", async () => {
    const access = toolAccessService(db);
    expect(await access.nextAggregatorAppSyncDueAt()).toBeNull();
  });

  it("reports the freshness deadline of the oldest cached list", async () => {
    const fixture = await setup(2);
    const [first, second] = fixture.connections;
    const oldest = new Date(Date.now() - 4 * 60_000);
    await db.update(toolConnectionAppSyncs).set({ lastCompletedAt: oldest, updatedAt: oldest })
      .where(eq(toolConnectionAppSyncs.connectionId, first!.id));

    const due = await fixture.access.nextAggregatorAppSyncDueAt();

    expect(due).toBe(oldest.getTime() + AGGREGATOR_APP_SYNC_TTL_MS);
    // A disabled gateway stops owning a deadline.
    await db.update(toolConnections).set({ enabled: false }).where(eq(toolConnections.id, first!.id));
    const next = await fixture.access.nextAggregatorAppSyncDueAt();
    const secondRow = await rowFor(second!.id);
    expect(next).toBe(secondRow.lastCompletedAt!.getTime() + AGGREGATOR_APP_SYNC_TTL_MS);
    expect(next!).toBeGreaterThan(due!);
  }, 120_000);

  it("marks a refresh that cannot start as failed and reports the gateway", async () => {
    const fixture = await setup(1);
    const [connection] = fixture.connections;
    await db.update(toolConnectionAppSyncs).set({ lastCompletedAt: stale(), updatedAt: stale() })
      .where(eq(toolConnectionAppSyncs.connectionId, connection!.id));
    // Without its account action the gateway cannot start a refresh; this is the
    // synchronous failure the sweep has to report instead of swallowing.
    await db.delete(toolCatalogEntries).where(eq(toolCatalogEntries.connectionId, connection!.id));

    const result = await fixture.access.sweepAggregatorAppSyncs({ timeBudgetMs: 60_000 });

    expect(result).toMatchObject({ checked: 1, refreshed: 0, skipped: 0 });
    expect(result.failedConnectionIds).toEqual([connection!.id]);
    // Failed rows leave the ready set: the app shows "Last check failed" and an
    // explicit Refresh takes over from the timer.
    expect((await rowFor(connection!.id)).status).toBe("error");
    const next = await fixture.access.sweepAggregatorAppSyncs({ timeBudgetMs: 60_000 });
    expect(next).toMatchObject({ checked: 0 });
  }, 120_000);
});
