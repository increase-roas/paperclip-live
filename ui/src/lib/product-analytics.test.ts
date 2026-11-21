import { describe, expect, it } from "vitest";

import { sanitizeAnalyticsRoute } from "./product-analytics";

describe("sanitizeAnalyticsRoute", () => {
  it("replaces company ids, task ids and numeric segments", () => {
    expect(
      sanitizeAnalyticsRoute("/acme/6f1d2c7a-1c2b-4c3d-8e9f-0123456789ab/tasks/PAP-123/42"),
    ).toBe("/acme/:id/tasks/:task/:n");
  });

  it("keeps a plain route unchanged", () => {
    expect(sanitizeAnalyticsRoute("/tasks")).toBe("/tasks");
  });

  it("bounds a long route", () => {
    expect(sanitizeAnalyticsRoute(`/${"x".repeat(400)}`).length).toBe(200);
  });
});
