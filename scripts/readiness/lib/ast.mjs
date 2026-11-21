import { parseSync, visitorKeys } from "oxc-parser";

/**
 * Thin wrapper over the pinned `oxc-parser` (the same parser the workspace
 * already uses) so analysis scripts share one traversal implementation.
 */

export function parseProgram(file, code) {
  const result = parseSync(file, code, { sourceType: "module" });
  return {
    program: result.program,
    errors: result.errors ?? [],
  };
}

export function walkAst(node, visit, parent = null) {
  if (!node || typeof node.type !== "string") return;
  visit(node, parent);
  const keys = visitorKeys[node.type];
  const childKeys = keys ?? Object.keys(node).filter((key) => key !== "parent");
  for (const key of childKeys) {
    if (key === "type" || key === "parent") continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const child of value) {
        if (child && typeof child === "object" && typeof child.type === "string") {
          walkAst(child, visit, node);
        }
      }
    } else if (value && typeof value === "object" && typeof value.type === "string") {
      walkAst(value, visit, node);
    }
  }
}

function identifierName(node) {
  if (!node) return null;
  if (node.type === "Identifier") return node.name;
  if (node.type === "PrivateIdentifier") return `#${node.name}`;
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  return null;
}

// Class/object members are containers: their `value` is the function node we
// measure. Counting the container too would double every method.
const FUNCTION_TYPES = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
]);

export function isFunctionNode(node) {
  return FUNCTION_TYPES.has(node.type);
}

/**
 * Resolves a stable, human-readable name for a function-like node. Object
 * methods and class members use their property key; inline callbacks fall back
 * to the nearest named binding and finally `<anonymous>`.
 */
export function describeFunction(node, parent) {
  if (node.type === "FunctionDeclaration" && node.id?.name) return node.id.name;
  if (node.type === "MethodDefinition" || node.type === "PropertyDefinition" || node.type === "TSAbstractMethodDefinition") {
    return identifierName(node.key) ?? "<anonymous>";
  }
  if (node.type === "FunctionExpression" && node.id?.name) return node.id.name;
  if (parent?.type === "Property" || parent?.type === "PropertyDefinition" || parent?.type === "MethodDefinition") {
    const name = identifierName(parent.key);
    if (name) return name;
  }
  if (parent?.type === "VariableDeclarator") {
    const name = identifierName(parent.id);
    if (name) return name;
  }
  if (parent?.type === "AssignmentExpression") {
    const name = identifierName(parent.left);
    if (name) return name;
  }
  if (parent?.type === "ExportDefaultDeclaration") return "default";
  return "<anonymous>";
}

export function hasBody(node) {
  return Boolean(node.body && node.body.type === "BlockStatement");
}

/** Collects module-level import/export specifiers (used by dependency checks). */
export function collectModuleSpecifiers(program) {
  const specifiers = new Set();
  const add = (value) => {
    if (typeof value === "string" && value) specifiers.add(value);
  };
  for (const statement of program.body) {
    if (statement.type === "ImportDeclaration") add(statement.source?.value);
    else if (statement.type === "ExportNamedDeclaration" || statement.type === "ExportAllDeclaration") {
      add(statement.source?.value);
    }
  }
  return specifiers;
}
