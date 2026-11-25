import { normalizePastedMarkdown } from "./markdownPaste";

/**
 * Normalize pasted markdown by removing common leading whitespace (dedent)
 * and normalizing line endings. This fixes formatting issues when pasting
 * content from terminals/consoles that add uniform indentation.
 */
export function normalizeMarkdown(text: string): string {
  const normalized = normalizePastedMarkdown(text);

  const lines = normalized.split("\n");
  if (lines.length <= 1) return normalized;

  // Find minimum indentation across non-empty lines
  let minIndent = Infinity;
  let indentStyle: "spaces" | "tabs" | null = null;
  for (const line of lines) {
    if (line.trim() === "") continue;
    const match = line.match(/^(\s+)/);
    if (match) {
      const leadingWhitespace = match[1];
      const currentStyle = leadingWhitespace.includes("\t") ? "tabs" : "spaces";
      if (indentStyle && indentStyle !== currentStyle) {
        return normalized;
      }
      indentStyle = currentStyle;
      minIndent = Math.min(minIndent, leadingWhitespace.length);
    } else {
      minIndent = 0;
      break;
    }
  }

  if (minIndent === 0 || minIndent === Infinity) return normalized;

  // Strip common indent and trim whitespace-only lines
  return lines
    .map((line) => line.trim() === "" ? "" : line.slice(minIndent))
    .join("\n");
}
