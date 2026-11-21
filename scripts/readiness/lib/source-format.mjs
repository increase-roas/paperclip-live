/**
 * Mechanical source formatting rules shared by the formatter and its tests:
 * UTF-8 without BOM, LF endings, no trailing whitespace, exactly one final
 * newline. Markdown hard line breaks (two trailing spaces) are preserved.
 */
export function formatSource(text, extension) {
  const violations = [];
  let normalized = text;

  if (normalized.charCodeAt(0) === 0xfeff) {
    violations.push({ rule: "bom", message: "file starts with a UTF-8 BOM" });
    normalized = normalized.slice(1);
  }
  if (normalized.includes("\r\n")) {
    violations.push({ rule: "crlf", message: "file uses CRLF line endings" });
    normalized = normalized.replace(/\r\n/g, "\n");
  } else if (normalized.includes("\r")) {
    violations.push({ rule: "cr", message: "file contains a bare carriage return" });
    normalized = normalized.replace(/\r/g, "\n");
  }

  const lines = normalized.split("\n");
  const keepMarkdownHardBreak = extension === ".md" || extension === ".mdx";
  const rewritten = lines.map((line, index) => {
    const withoutTrailing = line.replace(/[ \t]+$/, "");
    if (withoutTrailing === line) return line;

    const trailing = line.slice(withoutTrailing.length);
    if (keepMarkdownHardBreak && trailing === "  " && withoutTrailing !== "") {
      return line;
    }

    violations.push({
      rule: "trailing-whitespace",
      line: index + 1,
      message: "line ends with whitespace",
    });
    return withoutTrailing;
  });

  normalized = rewritten.join("\n");

  if (!normalized.endsWith("\n")) {
    violations.push({ rule: "final-newline", message: "file does not end with a newline" });
    normalized = `${normalized}\n`;
  } else if (normalized.endsWith("\n\n")) {
    const withoutExtra = normalized.replace(/\n+$/, "\n");
    if (withoutExtra !== normalized) {
      violations.push({ rule: "multiple-final-newlines", message: "file ends with more than one newline" });
      normalized = withoutExtra;
    }
  }

  return { formatted: normalized, violations };
}
