import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { errorHandler } from "../middleware/error-handler.js";
import { dashboardLane2BoardRoutes } from "./dashboard-lane2-boards.js";

const companyId = "11111111-1111-4111-8111-111111111111";
const otherCompanyId = "22222222-2222-4222-8222-222222222222";

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
      .get(`/api/companies/${companyId}/dashboards/ceo`)
      .expect(404);
  });
});
