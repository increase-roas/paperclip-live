import type { Db } from "@paperclipai/db";
import { describe, expect, it, vi } from "vitest";
import { dashboardFulfillmentService } from "./dashboard-fulfillment.js";

function queryResult<T>(rows: T[]) {
  const result = Promise.resolve(rows);
  return Object.assign(result, {
    from: () => result,
    leftJoin: () => result,
    where: () => result,
    orderBy: () => result,
  });
}

function boardForProjects(projectIds: Array<string | null>) {
  const now = new Date("2026-11-26T00:00:00Z");
  const rows = projectIds.map((projectId, index) => ({
    id: `task-${index}`,
    identifier: `INC-${index + 1}`,
    title: "Client work",
    status: "todo",
    projectId,
    projectName: projectId ? "Same client name" : null,
    createdAt: now,
  }));
  const db = {
    select: vi.fn()
      .mockReturnValueOnce(queryResult([]))
      .mockReturnValueOnce(queryResult(rows))
      .mockReturnValueOnce(queryResult([])),
  };
  return dashboardFulfillmentService(db as unknown as Db).board("company-1", now);
}

describe("dashboardFulfillmentService client counts", () => {
  it("counts all distinct client projects before truncation, excluding unassigned tasks", async () => {
    const board = await boardForProjects([
      ...Array.from({ length: 11 }, (_, index) => `client-${index}`),
      "client-0",
      null,
    ]);

    expect(board.clientsWithOpenWork).toBe(11);
    expect(board.clients).toHaveLength(10);
    expect(board.openClientTasks).toEqual({ total: 12, unassigned: 1 });
    expect(board.clients[0]).toMatchObject({ clientKey: "client-0", openTasks: 2 });
  });

  it("returns zero for an empty roster or only unassigned work", async () => {
    expect((await boardForProjects([])).clientsWithOpenWork).toBe(0);
    const board = await boardForProjects([null]);
    expect(board.clientsWithOpenWork).toBe(0);
    expect(board.clients).toEqual([]);
    expect(board.openClientTasks).toEqual({ total: 0, unassigned: 1 });
  });
});
