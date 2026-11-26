import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/error-handler.js";
import { ceoBoardService } from "../ir/ceo-board.js";
import { dashboardBoardService } from "../services/dashboard-boards.js";
import { dashboardLane2BoardRoutes } from "./dashboard-lane2-boards.js";

const companyId = "11111111-1111-4111-8111-111111111111";
const otherCompanyId = "22222222-2222-4222-8222-222222222222";
const ENV_KEYS = [
  "SALES_DASHBOARD_ADMIN_KEY",
  "GATEWAY_PAPERCLIP_KEY",
  "GATEWAY_WAVV_KEY",
  "GATEWAY_META_KEY",
  "GATEWAY_GHL_KEY",
  "GHL_ALEX_BLOOMFIELD_PIT_KEY",
  "GHL_ALEX_BLOOMFIELD_LOCATION_ID",
] as const;

function app(actor: Express.Request["actor"] = {
  type: "board",
  source: "session",
  userId: "signed-in-user",
  companyIds: [companyId],
}) {
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  server.use("/api", dashboardLane2BoardRoutes());
  server.use(errorHandler);
  return server;
}

describe("dashboard board routes", () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });
  it.each(["sales", "marketing", "human-employees"] as const)(
    "serves the %s board for a company the caller belongs to",
    async (board) => {
      const response = await request(app())
        .get(`/api/companies/${companyId}/dashboards/${board}`)
        .expect(200);
      expect(response.body.board).toBe(board);
      expect(response.body.companyId).toBe(companyId);
      expect(response.body.tiles.every((tile: { value: { kind: string } }) => tile.value.kind === "not_connected")).toBe(true);
      expect(response.body.tables.every((table: { rows: unknown[] }) => table.rows.length === 0)).toBe(true);
    },
  );

  it("rejects a caller who does not belong to the company", async () => {
    await request(app())
      .get(`/api/companies/${otherCompanyId}/dashboards/sales`)
      .expect(403);
  });

  it("rejects an unauthenticated caller", async () => {
    await request(app({ type: "none", source: "none" }))
      .get(`/api/companies/${companyId}/dashboards/sales`)
      .expect(401);
  });

  it("returns 404 for an unknown board instead of an empty board", async () => {
    await request(app())
      .get(`/api/companies/${companyId}/dashboards/nonexistent`)
      .expect(404);
  });

  it("serves CEO money tiles and reading-order endpoints with period support", async () => {
    const ceoRes = await request(app())
      .get(`/api/companies/${companyId}/dashboards/ceo?period=7d`)
      .expect(200);
    expect(ceoRes.body.companyId).toBe(companyId);
    expect(ceoRes.body.period).toBe("7d");
    expect(ceoRes.body.moneyTiles).toHaveLength(6);

    const roRes = await request(app())
      .get(`/api/companies/${companyId}/dashboards/reading-order?period=month`)
      .expect(200);
    expect(roRes.body.companyId).toBe(companyId);
    expect(roRes.body.period).toBe("month");
    expect(Object.keys(roRes.body.statuses)).toHaveLength(8);
  });

  it("rejects unauthorized company access on ceo and reading-order routes", async () => {
    await request(app())
      .get(`/api/companies/${otherCompanyId}/dashboards/ceo`)
      .expect(403);
    await request(app())
      .get(`/api/companies/${otherCompanyId}/dashboards/reading-order`)
      .expect(403);
  });

  it("gates instance-global payroll, agency QBO, and portfolio reads away from agent keys and non-admin company members", async () => {
    process.env.SALES_DASHBOARD_ADMIN_KEY = "live-secret-key";
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          ok: true,
          generatedAt: "2026-11-23T12:00:00.000Z",
          view: "30d",
          owner: {
            slug: "__owner__",
            displayName: "Agency",
            syncedAt: "2026-11-23T12:00:00.000Z",
            syncStatus: "success",
            marketing: { cashCollectedUsd: 90000, evidence: { financial: true } },
            financialMonth: null,
          },
          clients: [],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const makeServer = (actor: Express.Request["actor"]) => {
      const server = express();
      server.use(express.json());
      server.use((req, _res, next) => {
        req.actor = actor;
        next();
      });
      server.use(
        "/api",
        dashboardLane2BoardRoutes(
          dashboardBoardService(undefined, { fetchImpl: fetchMock as unknown as typeof fetch }),
          ceoBoardService(undefined, { fetchImpl: fetchMock as unknown as typeof fetch }),
        ),
      );
      server.use(errorHandler);
      return server;
    };

    const agentServer = makeServer({
      type: "agent",
      agentId: "agent-1",
      companyId,
      source: "agent_key",
    });
    const nonAdminServer = makeServer({
      type: "board",
      source: "session",
      userId: "member-1",
      isInstanceAdmin: false,
      companyIds: [companyId],
    });
    const adminServer = makeServer({
      type: "board",
      source: "session",
      userId: "admin-1",
      isInstanceAdmin: true,
      companyIds: [companyId],
    });

    for (const server of [agentServer, nonAdminServer]) {
      const ceoRes = await request(server).get(`/api/companies/${companyId}/dashboards/ceo`).expect(200);
      expect(ceoRes.body.moneyTiles.every((t: { value: { kind: string } }) => t.value.kind === "not_connected")).toBe(true);
      const humanRes = await request(server).get(`/api/companies/${companyId}/dashboards/human-employees`).expect(200);
      expect(humanRes.body.tiles.every((t: { value: { kind: string } }) => t.value.kind === "not_connected")).toBe(true);
    }
    expect(fetchMock).not.toHaveBeenCalled();

    const adminCeo = await request(adminServer).get(`/api/companies/${companyId}/dashboards/ceo`).expect(200);
    expect(adminCeo.body.moneyTiles.find((t: { id: string }) => t.id === "cash-collected")?.value).toMatchObject({
      kind: "live",
      value: 90000,
    });
    expect(fetchMock).toHaveBeenCalled();
  });
});
