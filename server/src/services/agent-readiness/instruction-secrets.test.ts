import { describe, expect, it } from "vitest";
import { scanInstructionFiles } from "./catalog.js";

describe("scanInstructionFiles", () => {
  it("separates credentials, GBrain, Neon and Hindsight by file", async () => {
    const files = [
      { path: "AGENTS.md", size: 120 },
      { path: "notes/credentials.md", size: 200 },
      { path: "notes/memory.md", size: 200 },
      { path: "notes/ads.md", size: 200 },
      { path: "assets/logo.png", size: 2048, binary: true },
      { path: "empty.md", size: 0 },
    ];
    const contents: Record<string, string> = {
      "AGENTS.md": "# Agent\nBe useful. GBrain is the team memory.",
      "notes/credentials.md": "api_key: sk-live-1234567890abcdef",
      "notes/memory.md": "Hindsight used to hold this. gbrain: https://srv2155332.tailde26a1.ts.net/mcp",
      "notes/ads.md": "Show Hindsight comparisons. neon_token: sk-live-1234567890abcdef",
      "assets/logo.png": "api_key: sk-live-1234567890abcdef",
    };

    const scan = await scanInstructionFiles(files, async (path) => contents[path] ?? "");

    expect(scan.secretFiles).toEqual(["notes/credentials.md", "notes/ads.md"]);
    expect(scan.gbrainFiles).toEqual(["AGENTS.md", "notes/memory.md"]);
    expect(scan.neonFiles).toEqual(["notes/ads.md"]);
    expect(scan.secretNeonFiles).toEqual(["notes/ads.md"]);
    expect(scan.hindsightFiles).toEqual(["notes/memory.md", "notes/ads.md"]);
  });

  it("ignores placeholders, oversized files and unreadable files", async () => {
    const files = [
      { path: "AGENTS.md", size: 40 },
      { path: "huge.md", size: 1024 * 1024 },
      { path: "broken.md", size: 40 },
    ];
    const scan = await scanInstructionFiles(files, async (path) => {
      if (path === "broken.md") throw new Error("unreadable");
      if (path === "huge.md") return "token: sk-live-1234567890abcdef";
      return "token: rotate-me";
    });

    expect(scan.secretFiles).toEqual([]);
    expect(scan.gbrainFiles).toEqual([]);
    expect(scan.hindsightFiles).toEqual([]);
  });
});
