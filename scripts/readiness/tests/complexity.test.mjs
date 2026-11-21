import assert from "node:assert/strict";
import test from "node:test";

import { analyzeComplexity } from "../lib/complexity.mjs";

function complexityOf(source, name) {
  const { functions, errors } = analyzeComplexity("sample.ts", source);
  assert.equal(errors.length, 0);
  const found = functions.find((entry) => entry.name === name);
  assert.ok(found, `expected a function named ${name}`);
  return found.complexity;
}

test("counts if, logical operators, loops and case clauses", () => {
  const source = `
    function pick(values) {
      let total = 0;
      if (values && values.length) {
        for (const value of values) {
          if (value > 1) total += value;
        }
      }
      switch (total) {
        case 1:
          break;
        default:
          break;
      }
      return total;
    }
  `;
  // 1 + if + && + for-of + if + case = 6
  assert.equal(complexityOf(source, "pick"), 6);
});

test("counts try/catch and ternary branches", () => {
  const source = `
    function parse(value) {
      try {
        return value ? Number(value) : 0;
      } catch {
        return 0;
      }
    }
  `;
  // 1 + ternary + catch = 3
  assert.equal(complexityOf(source, "parse"), 3);
});

test("measures class methods without double counting the container", () => {
  const source = `
    class Counter {
      value(input) {
        if (input > 0) return input;
        return 0;
      }
    }
  `;
  assert.equal(complexityOf(source, "value"), 2);
});

test("does not let nested functions inflate the outer function", () => {
  const source = `
    function outer(items) {
      const inner = (item) => {
        if (item) return 1;
        if (item === 0) return 0;
        return -1;
      };
      return items.map(inner);
    }
  `;
  // Outer is just the declaration plus the map call: 1.
  assert.equal(complexityOf(source, "outer"), 1);
  assert.equal(complexityOf(source, "inner"), 3);
});

test("counts arrow callbacks with nullish coalescing", () => {
  const source = `
    const read = (options) => {
      return options.value ?? options.fallback ?? 0;
    };
  `;
  // 1 + two ?? operators = 3
  assert.equal(complexityOf(source, "read"), 3);
});
