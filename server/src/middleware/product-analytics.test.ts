import { describe, expect, it } from "vitest";

import { analyticsRouteTemplate } from "./product-analytics.js";

describe("analyticsRouteTemplate", () => {
  it("replaces UUIDs, task identifiers and numeric segments", () => {
    expect(
      analyticsRouteTemplate("/api/companies/6f1d2c7a-1c2b-4c3d-8e9f-0123456789ab/issues/PAP-123/comments/42"),
    ).toBe("/api/companies/:id/issues/:task/comments/:n");
  });

  it("keeps a route with no identifiers unchanged", () => {
    expect(analyticsRouteTemplate("/api/issues")).toBe("/api/issues");
  });

  it("bounds the template length", () => {
    expect(analyticsRouteTemplate(`/api/${"x".repeat(400)}`).length).toBe(200);
  });
});
