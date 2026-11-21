import { describeFunction, hasBody, isFunctionNode, parseProgram, walkAst } from "./ast.mjs";
import { createLineIndex } from "./lines.mjs";

/**
 * Cyclomatic complexity for TypeScript/JavaScript.
 *
 * The count follows the widely used McCabe definition: one decision point per
 * `if`, loop, `case`, `catch`, ternary, short-circuit/coalescing operator and
 * logical assignment. Nested function bodies are measured separately and do
 * not inflate the enclosing function.
 */

const DECISION_NODES = new Set([
  "IfStatement",
  "ConditionalExpression",
  "ForStatement",
  "ForInStatement",
  "ForOfStatement",
  "WhileStatement",
  "DoWhileStatement",
  "CatchClause",
]);

const LOGICAL_OPERATORS = new Set(["&&", "||", "??"]);
const LOGICAL_ASSIGNMENTS = new Set(["&&=", "||=", "??="]);

function decisionPoints(node, parent) {
  if (DECISION_NODES.has(node.type)) return 1;
  if (node.type === "SwitchCase" && node.test) return 1;
  if (node.type === "LogicalExpression" && LOGICAL_OPERATORS.has(node.operator)) return 1;
  if (node.type === "AssignmentExpression" && LOGICAL_ASSIGNMENTS.has(node.operator)) return 1;
  if (node.type === "AssignmentPattern" && parent?.type === "CatchClause") return 0;
  return 0;
}

function childKeys(node) {
  const keys = [];
  for (const key of Object.keys(node)) {
    if (key === "type" || key === "start" || key === "end") continue;
    const value = node[key];
    if (Array.isArray(value)) {
      if (value.some((item) => item && typeof item === "object" && typeof item.type === "string")) {
        keys.push(key);
      }
    } else if (value && typeof value === "object" && typeof value.type === "string") {
      keys.push(key);
    }
  }
  return keys;
}

function bodyOf(node) {
  return node.body;
}

function complexityOfFunctionBody(body) {
  let complexity = 1;
  const visit = (node) => {
    if (!node || typeof node.type !== "string") return;
    if (isFunctionNode(node) && hasBody(node)) return;
    complexity += decisionPoints(node, null);
    for (const key of childKeys(node)) {
      const value = node[key];
      if (Array.isArray(value)) {
        for (const item of value) visit(item);
      } else {
        visit(value);
      }
    }
  };
  for (const key of childKeys(body)) {
    const value = body[key];
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
    } else {
      visit(value);
    }
  }
  return complexity;
}

/**
 * Returns `{ functions, errors }`. Each function record carries its cyclomatic
 * complexity, one-based starting line and name.
 */
export function analyzeComplexity(file, code) {
  const { program, errors } = parseProgram(file, code);
  const lineAt = createLineIndex(code);
  const functions = [];

  walkAst(program, (node, parent) => {
    if (!isFunctionNode(node) || !hasBody(node)) return;
    functions.push({
      file,
      name: describeFunction(node, parent),
      line: lineAt(node.start),
      complexity: complexityOfFunctionBody(bodyOf(node)),
    });
  });

  return { functions, errors };
}

export function complexityFindings(functions, threshold) {
  return functions
    .filter((entry) => entry.complexity > threshold)
    .sort((left, right) => right.complexity - left.complexity || left.file.localeCompare(right.file));
}
