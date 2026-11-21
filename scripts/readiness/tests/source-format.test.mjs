import assert from "node:assert/strict";
import test from "node:test";

import { formatSource } from "../lib/source-format.mjs";

test("normalizes CRLF and a missing final newline", () => {
  const result = formatSource("const a = 1;\r\nconst b = 2;", ".ts");
  assert.equal(result.formatted, "const a = 1;\nconst b = 2;\n");
  assert.deepEqual(
    result.violations.map((violation) => violation.rule),
    ["crlf", "final-newline"],
  );
});

test("strips trailing whitespace and extra final newlines", () => {
  const result = formatSource("const a = 1;   \n\n\n", ".ts");
  assert.equal(result.formatted, "const a = 1;\n");
  assert.ok(result.violations.some((violation) => violation.rule === "trailing-whitespace"));
  assert.ok(result.violations.some((violation) => violation.rule === "multiple-final-newlines"));
});

test("preserves Markdown hard line breaks", () => {
  const result = formatSource("line one  \nline two\n", ".md");
  assert.equal(result.formatted, "line one  \nline two\n");
  assert.equal(result.violations.length, 0);
});

test("removes a UTF-8 BOM", () => {
  const result = formatSource("\uFEFFexport const x = 1;\n", ".ts");
  assert.equal(result.formatted, "export const x = 1;\n");
  assert.deepEqual(result.violations.map((violation) => violation.rule), ["bom"]);
});

test("leaves conforming content untouched", () => {
  const source = "export function add(a: number, b: number): number {\n  return a + b;\n}\n";
  const result = formatSource(source, ".ts");
  assert.equal(result.formatted, source);
  assert.equal(result.violations.length, 0);
});
