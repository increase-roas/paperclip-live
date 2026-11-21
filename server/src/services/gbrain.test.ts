import { describe, expect, it } from "vitest";
import { evaluateGbrainAttachment, GBRAIN_MCP_URL, readGbrainMarker } from "./gbrain.js";

const connection = (overrides: Partial<{
  id: string;
  applicationKey: string | null;
  enabled: boolean;
  healthStatus: string | null;
}> = {}) => ({
  id: "conn-gbrain",
  applicationKey: "gbrain",
  enabled: true,
  healthStatus: "healthy",
  ...overrides,
});

describe("readGbrainMarker", () => {
  it("reads the marker written at hire", () => {
    expect(readGbrainMarker({
      gbrain: { url: GBRAIN_MCP_URL, attachedAt: "2026-11-21T00:00:00.000Z", mode: "marker", connectionId: null },
    })).toMatchObject({ url: GBRAIN_MCP_URL, mode: "marker", connectionId: null });
  });

  it("returns null when the agent has no marker", () => {
    expect(readGbrainMarker({})).toBeNull();
    expect(readGbrainMarker(null)).toBeNull();
  });
});

describe("evaluateGbrainAttachment", () => {
  it("treats the hire marker as intent, not attachment", () => {
    const result = evaluateGbrainAttachment({
      marker: { url: GBRAIN_MCP_URL, attachedAt: null, mode: "marker", connectionId: null },
      connections: [],
      agentConnectionIds: [],
      instructionsMention: false,
    });
    expect(result.attached).toBe(false);
    expect(result.markerOnly).toBe(true);
    expect(result.source).toBe("metadata");
  });

  it("attaches from the hire marker once the connector exists", () => {
    const result = evaluateGbrainAttachment({
      marker: { url: GBRAIN_MCP_URL, attachedAt: null, mode: "connector", connectionId: "conn-gbrain" },
      connections: [connection()],
      agentConnectionIds: [],
      instructionsMention: false,
    });
    expect(result).toMatchObject({ attached: true, source: "metadata", healthStatus: "healthy", healthy: true });
  });

  it("attaches from an agent connector install", () => {
    const result = evaluateGbrainAttachment({
      marker: null,
      connections: [connection()],
      agentConnectionIds: ["conn-gbrain"],
      instructionsMention: false,
    });
    expect(result).toMatchObject({ attached: true, source: "connector", connectionId: "conn-gbrain" });
  });

  it("attaches when the profile configuration names the MCP server", () => {
    const result = evaluateGbrainAttachment({
      marker: null,
      connections: [],
      agentConnectionIds: [],
      instructionsMention: true,
    });
    expect(result).toMatchObject({ attached: true, source: "instructions" });
  });

  it("stays unattached with no marker, connector or profile entry", () => {
    const result = evaluateGbrainAttachment({
      marker: null,
      connections: [],
      agentConnectionIds: [],
      instructionsMention: false,
    });
    expect(result.attached).toBe(false);
    expect(result.source).toBeNull();
  });

  it("marks an unchecked connector pending rather than healthy", () => {
    const result = evaluateGbrainAttachment({
      marker: null,
      connections: [connection({ healthStatus: "unchecked" })],
      agentConnectionIds: ["conn-gbrain"],
      instructionsMention: false,
    });
    expect(result.pending).toBe(true);
    expect(result.healthy).toBe(false);
  });

  it("does not attach a disabled connector", () => {
    const result = evaluateGbrainAttachment({
      marker: null,
      connections: [connection({ enabled: false })],
      agentConnectionIds: ["conn-gbrain"],
      instructionsMention: false,
    });
    expect(result.attached).toBe(false);
  });
});
