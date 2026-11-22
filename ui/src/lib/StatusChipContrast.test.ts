import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const stylesheet = readFileSync(fileURLToPath(new URL("../index.css", import.meta.url)), "utf8");

function cssRule(selector: string): string {
  const start = stylesheet.indexOf(`\n${selector} {`);
  expect(start, `Missing CSS selector: ${selector}`).toBeGreaterThanOrEqual(0);
  const bodyStart = stylesheet.indexOf("{", start);
  const bodyEnd = stylesheet.indexOf("\n}", bodyStart);
  return stylesheet.slice(bodyStart + 1, bodyEnd);
}

function rgb(hex: string): [number, number, number] {
  const match = hex.match(/^#([0-9a-f]{6})$/i);
  expect(match, `Expected a six-digit hex color, got ${hex}`).not.toBeNull();
  const value = match![1];
  return [0, 2, 4].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16)) as [number, number, number];
}

function mix(first: [number, number, number], second: [number, number, number], weight: number) {
  return first.map((channel, index) => channel * weight + second[index] * (1 - weight)) as [number, number, number];
}

function luminance([r, g, b]: [number, number, number]) {
  const channel = (value: number) => {
    const normalized = value / 255;
    return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrastRatio(first: [number, number, number], second: [number, number, number]) {
  const [lighter, darker] = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

describe("status chip contrast", () => {
  const rule = cssRule(".status-chip");
  const fillWeight = Number(rule.match(/background-color:\s*color-mix\(in srgb, var\(--sc\) (\d+)%, white\)/)?.[1]);
  const textWeight = Number(rule.match(/color:\s*color-mix\(in srgb, var\(--sc\) (\d+)%, black\)/)?.[1]);

  it("uses a dark enough light-mode text mix", () => {
    expect(fillWeight).toBe(15);
    expect(textWeight).toBeLessThanOrEqual(60);
  });

  it("keeps every base status hue above AA on its tinted fill", () => {
    const hues = [...stylesheet.matchAll(/--status-(?:agent|task)-(idle|running|paused|error|backlog|todo|in_progress|in_review|done|blocked):\s*(#[0-9a-f]{6});/gi)]
      .map((match) => ({ status: match[1], hex: match[2] }));
    expect(hues.length, "base status hues").toBeGreaterThanOrEqual(8);

    for (const { status, hex } of hues) {
      const hue = rgb(hex);
      const fill = mix(hue, [255, 255, 255], fillWeight / 100);
      const text = mix(hue, [0, 0, 0], textWeight / 100);
      expect(contrastRatio(fill, text), `${status} chip contrast`).toBeGreaterThanOrEqual(4.5);
    }
  });
});
