import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { queryKeys } from "./queryKeys";
import { invalidateBotViewsForAgent } from "./invalidate-bot-views";

function settledClient(...keys: readonly (readonly unknown[])[]) {
  const client = new QueryClient();
  for (const key of keys) {
    const query = client.getQueryCache().build(client, { queryKey: key, queryFn: async () => null });
    query.setState({ status: "success", data: null, dataUpdatedAt: Date.now(), error: null });
  }
  return client;
}

describe("invalidateBotViewsForAgent", () => {
  it("marks the roster and the agent's bot page stale", () => {
    const client = settledClient(
      queryKeys.bots.list("company-1"),
      queryKeys.bots.detail("company-1", "agent-1"),
      queryKeys.bots.list("company-2"),
    );

    invalidateBotViewsForAgent(client, "company-1", "agent-1");

    expect(client.getQueryState(queryKeys.bots.list("company-1"))?.isInvalidated).toBe(true);
    expect(client.getQueryState(queryKeys.bots.detail("company-1", "agent-1"))?.isInvalidated).toBe(true);
    expect(client.getQueryState(queryKeys.bots.list("company-2"))?.isInvalidated).toBe(false);
  });

  it("does nothing without a company scope", () => {
    const client = settledClient(queryKeys.bots.list("company-1"));

    invalidateBotViewsForAgent(client, null, "agent-1");

    expect(client.getQueryState(queryKeys.bots.list("company-1"))?.isInvalidated).toBe(false);
  });
});
