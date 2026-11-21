import { describe, expect, it } from "vitest";
import { hermesHasMcpToolset, hermesToolsets, isHermesAdapter, resolveHermesProfile } from "./hermes-profile.js";

describe("Hermes profile resolution", () => {
  it("accepts both Hermes adapter types", () => {
    expect(isHermesAdapter("hermes_local")).toBe(true);
    expect(isHermesAdapter("hermes_gateway")).toBe(true);
    expect(isHermesAdapter("claude_local")).toBe(false);
    expect(isHermesAdapter(null)).toBe(false);
  });

  it("reads the profile from the command alias", () => {
    expect(resolveHermesProfile({ hermesCommand: "jarvis" })).toBe("jarvis");
  });

  it("reads the profile from -p and --profile", () => {
    expect(resolveHermesProfile({ extraArgs: ["-p", "jarvis", "--verbose"] })).toBe("jarvis");
    expect(resolveHermesProfile({ extraArgs: ["--profile=jarvis"] })).toBe("jarvis");
  });

  it("treats the bare hermes binary as no profile", () => {
    expect(resolveHermesProfile({ hermesCommand: "hermes" })).toBeNull();
    expect(resolveHermesProfile({})).toBeNull();
  });

  it("requires mcp in the toolset", () => {
    expect(hermesToolsets({ toolsets: "terminal, mcp" })).toEqual(["terminal", "mcp"]);
    expect(hermesHasMcpToolset({ toolsets: "terminal" })).toBe(false);
    expect(hermesHasMcpToolset({ enabledToolsets: ["mcp"] })).toBe(true);
  });
});
