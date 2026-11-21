#!/usr/bin/env node

import { createLineIndex } from "./readiness/lib/lines.mjs";
import { parseProgram, walkAst } from "./readiness/lib/ast.mjs";
import { loadBaseline, saveBaseline, splitByBaseline } from "./readiness/lib/baselines.mjs";
import {
  SOURCE_EXTENSIONS,
  gitTrackedFiles,
  isIgnoredPath,
  isTestFile,
  listFiles,
  readText,
  repoPath,
} from "./readiness/lib/files.mjs";
import { parseArgs, readJsonFile, settle } from "./readiness/lib/report.mjs";

/**
 * Enforces the naming standard documented in doc/agent-readiness/CODE-STANDARDS.md.
 *
 * Rules:
 *  1. Backend, CLI, package and script files use kebab-case.
 *  2. Drizzle schema modules use snake_case (they mirror table names).
 *  3. Hook modules in ui/src/hooks use the `useThing` form.
 *  4. Files that render JSX in component directories use PascalCase.
 *  5. Type-like declarations (class, interface, type alias, enum) use PascalCase.
 *  6. Unit tests use `.test.` next to their source; `.spec.` is reserved for
 *     the browser/e2e suites under tests/.
 *
 * Pre-existing violations are acknowledged in the baseline; any new violation
 * fails the check.
 */

const KEBAB_CASE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SNAKE_CASE = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;
const PASCAL_CASE = /^[A-Z][A-Za-z0-9]*$/;
const HOOK_CASE = /^use[A-Z][A-Za-z0-9]*$/;

const KEBAB_ROOTS = [
  /^server\/src\//,
  /^cli\/src\//,
  /^packages\/(?!db\/src\/schema\/)[^/]+\/src\//,
  /^packages\/adapters\/[^/]+\/src\//,
  /^packages\/plugins\/[^/]+\/src\//,
  /^scripts\//,
  /^\.github\/scripts\//,
  /^tools\//,
];

const SNAKE_ROOTS = [/^packages\/db\/src\/schema\//];

const COMPONENT_ROOTS = [
  /^ui\/src\/components\//,
  /^ui\/src\/pages\//,
  /^ui\/src\/context\//,
  /^ui\/src\/artifact-directions\//,
];

const HOOK_ROOT = /^ui\/src\/hooks\//;

const TYPE_DECLARATIONS = new Set([
  "ClassDeclaration",
  "TSInterfaceDeclaration",
  "TSTypeAliasDeclaration",
  "TSEnumDeclaration",
]);

function baseName(relativePath) {
  const file = relativePath.split("/").pop();
  // Strip only the trailing extension chain: `AgentDetail.accounting.test.tsx`
  // keeps `AgentDetail` as the module name.
  return file.replace(/\.(?:[cm]?[jt]sx?|d\.ts)$/, "").split(".")[0];
}

function hasJsx(program) {
  let found = false;
  walkAst(program, (node) => {
    if (found) return;
    if (node.type === "JSXElement" || node.type === "JSXFragment") found = true;
  });
  return found;
}

function declarationFindings(relativePath, program, lineAt) {
  const findings = [];
  walkAst(program, (node) => {
    if (!TYPE_DECLARATIONS.has(node.type)) return;
    const name = node.id?.name;
    if (!name) return;
    if (!PASCAL_CASE.test(name)) {
      findings.push({
        file: relativePath,
        line: lineAt(node.start),
        key: `${relativePath}#decl:${name}`,
        message: `${node.type} "${name}" must use PascalCase`,
      });
    }
  });
  return findings;
}

function main() {
  const args = parseArgs();
  const config = readJsonFile(".quality/naming.json", {});
  const ignore = config.ignore ?? [];
  const updateBaseline = args.flags.has("update-baseline");
  const candidates = gitTrackedFiles() ?? listFiles({ roots: ["."], extensions: SOURCE_EXTENSIONS });
  const findings = [];

  for (const file of candidates) {
    const relativePath = repoPath(file);
    if (!relativePath || relativePath.startsWith("..")) continue;
    if (!SOURCE_EXTENSIONS.has(relativePath.slice(relativePath.lastIndexOf(".")))) continue;
    if (isIgnoredPath(relativePath, { ignore })) continue;
    if (relativePath.endsWith(".d.ts")) continue;
    if (/(^|\/)(?:generated|dist|node_modules)\//.test(relativePath)) continue;

    const name = baseName(relativePath);
    if (!name) continue;
    const isTest = isTestFile(relativePath);

    if (KEBAB_ROOTS.some((pattern) => pattern.test(relativePath)) && !KEBAB_CASE.test(name)) {
      findings.push({
        file: relativePath,
        key: `${relativePath}#filename`,
        message: `file name "${name}" must use kebab-case in this directory`,
      });
    } else if (SNAKE_ROOTS.some((pattern) => pattern.test(relativePath)) && !SNAKE_CASE.test(name)) {
      findings.push({
        file: relativePath,
        key: `${relativePath}#filename`,
        message: `file name "${name}" must use snake_case in this directory`,
      });
    }

    if (HOOK_ROOT.test(relativePath) && name !== "index" && !HOOK_CASE.test(name)) {
      findings.push({
        file: relativePath,
        key: `${relativePath}#filename`,
        message: `hook module "${name}" must start with "use" and use camelCase`,
      });
    }

    if (relativePath.includes("/src/") && /\.spec\.[cm]?[jt]sx?$/.test(relativePath)) {
      findings.push({
        file: relativePath,
        key: `${relativePath}#test-suffix`,
        message: "unit tests must use the .test suffix; .spec is reserved for tests/ suites",
      });
    }

    let parsed = null;
    let code = null;
    try {
      code = readText(file);
      parsed = parseProgram(file, code);
    } catch {
      continue;
    }
    if (parsed.errors.length) continue;
    const lineAt = createLineIndex(code);

    if (
      !isTest &&
      COMPONENT_ROOTS.some((pattern) => pattern.test(relativePath)) &&
      !PASCAL_CASE.test(name) &&
      name !== "index" &&
      hasJsx(parsed.program)
    ) {
      findings.push({
        file: relativePath,
        key: `${relativePath}#jsx-component`,
        message: `JSX component module "${name}" must use PascalCase`,
      });
    }

    findings.push(...declarationFindings(relativePath, parsed.program, lineAt));
  }

  if (updateBaseline) {
    const { count, path } = saveBaseline("naming", findings, (finding) => finding.key, {
      note: "Pre-existing naming violations. New files and declarations must follow CODE-STANDARDS.md.",
    });
    process.stdout.write(`Wrote ${count} entries to ${repoPath(path)}\n`);
    return;
  }

  const baseline = loadBaseline("naming");
  const { newFindings, knownFindings } = splitByBaseline(findings, baseline, (finding) => finding.key);
  settle({
    title: "Naming conventions",
    newFindings,
    knownFindings,
    notes: [`Checked ${candidates.length} tracked source files.`],
  });
}

main();
