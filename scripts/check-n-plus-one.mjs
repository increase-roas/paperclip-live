#!/usr/bin/env node

import { createHash } from "node:crypto";

import { isFunctionNode, parseProgram, walkAst } from "./readiness/lib/ast.mjs";
import { loadBaseline, saveBaseline, splitByBaseline } from "./readiness/lib/baselines.mjs";
import { createLineIndex } from "./readiness/lib/lines.mjs";
import { gitTrackedFiles, isIgnoredPath, readText, repoPath, repoRoot } from "./readiness/lib/files.mjs";
import { parseArgs, readJsonFile, settle } from "./readiness/lib/report.mjs";

/**
 * Static N+1 query detector.
 *
 * Flags an awaited database call inside a loop body, and an awaited database
 * call inside `forEach`/`map`/`reduce` callbacks. Sequential per-row queries
 * are the classic N+1 pattern; a batched query, a join or a DataLoader-style
 * loader removes the warning.
 *
 * The heuristic is intentionally conservative: only calls on a database-like
 * receiver (`db`, `tx`, `trx`, `client`, `query`, `sql`) or Drizzle terminal
 * methods (`select`, `insert`, `update`, `delete`, `execute`, `queryRaw`)
 * count. `Promise.all(...)` batches are not reported.
 */

const LOOP_TYPES = new Set([
  "ForStatement",
  "ForInStatement",
  "ForOfStatement",
  "WhileStatement",
  "DoWhileStatement",
]);

const ITERATION_METHODS = new Set(["forEach", "map", "flatMap", "reduce", "filter"]);

const DB_RECEIVER =
  /\b(?:db|tx|trx|database|client|conn|query|sql|repository|repo)\b|\bthis\.(?:db|tx|trx)\b/;
const DB_TERMINAL = /\.(?:select|insert|update|delete|execute|queryRaw|executeRaw|findMany|findFirst)\s*\(/;

function walkChildren(node, visit) {
  for (const key of Object.keys(node)) {
    if (key === "type" || key === "start" || key === "end") continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const child of value) {
        if (child && typeof child === "object" && typeof child.type === "string") visit(child);
      }
    } else if (value && typeof value === "object" && typeof value.type === "string") {
      visit(value);
    }
  }
}

function sourceSlice(code, node, limit = 180) {
  return code.slice(node.start, Math.min(node.end, node.start + limit)).replace(/\s+/g, " ");
}

function main() {
  const args = parseArgs();
  const config = readJsonFile(".quality/n-plus-one.json", {});
  const roots = config.roots ?? ["server/src", "packages/*/src", "packages/adapters/*/src"];
  const exclude = config.exclude ?? [];
  const files = (gitTrackedFiles() ?? [])
    .map((file) => repoPath(file))
    .filter((relativePath) => /\.(?:ts|tsx)$/.test(relativePath))
    .filter((relativePath) => roots.some((root) => relativePath.startsWith(`${root.replace(/\*.*$/, "")}`)))
    .filter((relativePath) => !isIgnoredPath(relativePath, { ignore: exclude }));

  const findings = [];
  for (const relativePath of files) {
    let code;
    let program;
    try {
      code = readText(`${repoRoot}/${relativePath}`);
      program = parseProgram(`${repoRoot}/${relativePath}`, code).program;
    } catch {
      continue;
    }
    const lineAt = createLineIndex(code);

    const inspectLoop = (loopNode) => {
      const report = (awaited, callee) => {
        const key = `${relativePath}::${createHash("sha1").update(callee).digest("hex").slice(0, 12)}`;
        findings.push({
          file: relativePath,
          line: lineAt(awaited.start),
          key,
          message: "awaited database call inside a loop (N+1 query risk)",
          detail: callee,
        });
      };

      const visit = (node) => {
        if (!node || typeof node.type !== "string") return;
        if (isFunctionNode(node)) return;
        if (node.type === "AwaitExpression") {
          const callee = sourceSlice(code, node.argument);
          if (!/Promise\.all/.test(callee) && DB_TERMINAL.test(callee) && DB_RECEIVER.test(callee)) {
            report(node, callee);
          }
        }
        walkChildren(node, visit);
      };

      if (loopNode.body) walkChildren(loopNode.body, visit);
      if (loopNode.type === "ForOfStatement" && loopNode.body) walkChildren(loopNode.body, visit);
    };

    walkAst(program, (node) => {
      if (LOOP_TYPES.has(node.type)) inspectLoop(node);
      if (node.type !== "CallExpression") return;
      const member = node.callee;
      if (member?.type !== "MemberExpression") return;
      const method = member.property?.name;
      if (!ITERATION_METHODS.has(method)) return;
      const callback = node.arguments?.[0];
      if (!callback || !isFunctionNode(callback) || !callback.async) return;
      const visit = (child) => {
        if (!child || typeof child.type !== "string") return;
        if (child.type === "AwaitExpression") {
          const callee = sourceSlice(code, child.argument);
          if (DB_TERMINAL.test(callee) && DB_RECEIVER.test(callee)) {
            const key = `${relativePath}::${createHash("sha1").update(callee).digest("hex").slice(0, 12)}`;
            findings.push({
              file: relativePath,
              line: lineAt(child.start),
              key,
              message: `awaited database call inside ${method}() (N+1 query risk)`,
              detail: callee,
            });
          }
        }
        walkChildren(child, visit);
      };
      if (callback.body) walkChildren(callback.body, visit);
    });
  }

  const unique = [...new Map(findings.map((finding) => [finding.key, finding])).values()];

  if (args.flags.has("update-baseline")) {
    const { count, path } = saveBaseline("n-plus-one", unique, (finding) => finding.key, {
      note: "Sequential query patterns that predate the check. Batch, join or load them before adding new ones.",
    });
    process.stdout.write(`Wrote ${count} entries to ${repoPath(path)}\n`);
    return;
  }

  const baseline = loadBaseline("n-plus-one");
  const { newFindings, knownFindings } = splitByBaseline(unique, baseline, (finding) => finding.key);
  settle({
    title: "N+1 query patterns",
    newFindings,
    knownFindings,
    notes: [`Analyzed ${files.length} server/package source files.`],
  });
}

main();
