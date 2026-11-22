import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const stylesheet = readFileSync(fileURLToPath(new URL("../index.css", import.meta.url)), "utf8");

function cssBlock(selector: string): string {
  const start = stylesheet.indexOf(`\n${selector} {`);
  expect(start, `Missing CSS selector: ${selector}`).toBeGreaterThanOrEqual(0);
  const bodyStart = stylesheet.indexOf("{", start);
  const bodyEnd = stylesheet.indexOf("\n}", bodyStart);
  return stylesheet.slice(bodyStart + 1, bodyEnd);
}

function token(block: string, name: string): string {
  const match = block.match(new RegExp(`^\\s*--${name}:\\s*([^;]+);`, "m"));
  expect(match, `Missing token --${name}`).not.toBeNull();
  return match![1].trim();
}

function hexChannels(value: string): [number, number, number] {
  const match = value.match(/^#([0-9a-f]{6})$/i);
  expect(match, `Expected a six-digit hex color, got ${value}`).not.toBeNull();
  const hex = match![1];
  return [0, 2, 4].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16)) as [number, number, number];
}

function relativeLuminance(value: string): number {
  const [r, g, b] = hexChannels(value).map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(first: string, second: string): number {
  const [lighter, darker] = [relativeLuminance(first), relativeLuminance(second)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

describe("scoped contrast tokens", () => {
  // Sidebar recents and avatar fallbacks are secondary metadata on their own
  // surfaces. The shared muted foreground misses AA on those light fills, so
  // these two scoped tokens carry the darker light-theme value.
  const light = cssBlock(":root");

  it.each([
    ["design-sidebar-recent-foreground", "#ececec"],
    ["avatar-fallback-foreground", "#eeeeee"],
  ])("keeps %s readable at AA on its light surface", (name, surface) => {
    const foreground = token(light, name);
    expect(foreground).toBe("#666666");
    expect(contrastRatio(foreground, surface)).toBeGreaterThanOrEqual(4.5);
  });

  it("leaves both scoped tokens on the compliant muted foreground in dark mode", () => {
    const dark = cssBlock(".dark");
    expect(token(dark, "design-sidebar-recent-foreground")).toBe("var(--muted-foreground)");
    expect(token(dark, "avatar-fallback-foreground")).toBe("var(--muted-foreground)");
  });
});
