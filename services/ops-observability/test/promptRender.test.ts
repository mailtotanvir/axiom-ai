/**
 * Unit tests for the O2 diff engine and JSON-Schema-validated renderer.
 */

import { describe, expect, it } from "vitest";

import { diffLines, unifiedDiff } from "../src/prompts/diff.js";
import { extractVariables, renderTemplate } from "../src/prompts/render.js";
import { compareSemver } from "../src/prompts/types.js";

describe("unified diff", () => {
  it("produces empty output for identical templates", () => {
    expect(unifiedDiff("1.0.0", "1.0.0", "same\nlines", "same\nlines")).toEqual([]);
  });

  it("marks additions and removals with hunk headers", () => {
    const patch = unifiedDiff("1.0.0", "1.1.0", "hello\nworld", "hello\nbrave\nworld");
    expect(patch[0]).toBe("--- 1.0.0");
    expect(patch[1]).toBe("+++ 1.1.0");
    expect(patch).toContainEqual("@@ -1,2 +1,3 @@");
    expect(patch).toContainEqual(" hello");
    expect(patch).toContainEqual("+brave");
    expect(patch.filter((line) => /^-(?!-)/.test(line))).toHaveLength(0);
  });

  it("diffLines classifies every line", () => {
    const lines = diffLines("a\nb\nc", "a\nd\nc");
    expect(lines).toEqual([
      { kind: "context", text: "a", aLine: 1, bLine: 1 },
      { kind: "remove", text: "b", aLine: 2 },
      { kind: "add", text: "d", bLine: 2 },
      { kind: "context", text: "c", aLine: 3, bLine: 3 },
    ]);
  });
});

describe("template renderer", () => {
  const schema = {
    type: "object",
    properties: {
      customer_name: { type: "string" },
      ticket_count: { type: "integer", minimum: 0 },
    },
    required: ["customer_name"],
    additionalProperties: false,
  };

  it("extracts {{var}} names from templates", () => {
    expect(extractVariables("Hello {{customer_name}}, {{ ticket_count }} tickets!")).toEqual([
      "customer_name",
      "ticket_count",
    ]);
    // Code blocks and unknown syntax are left alone.
    expect(extractVariables("if (x) { y } {{1bad}}")).toEqual([]);
  });

  it("renders string and JSON values after schema validation passes", () => {
    const result = renderTemplate(
      "k",
      "Hello {{customer_name}}, you have {{ticket_count}} tickets.",
      { customer_name: "Ada", ticket_count: 3 },
      schema,
    );
    expect(result.ok).toBe(true);
    expect(result.rendered).toBe("Hello Ada, you have 3 tickets.");
  });

  it("rejects variables violating the version's JSON Schema", () => {
    const result = renderTemplate("k", "Hello {{customer_name}}", { customer_name: 42 }, schema);
    expect(result.ok).toBe(false);
    expect(result.errors?.length).toBeGreaterThan(0);
  });

  it("reports missing variables without rendering", () => {
    const result = renderTemplate(
      "k",
      "{{customer_name}} / {{missing_one}}",
      { customer_name: "Ada" },
      null,
    );
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([
      { path: "/missing_one", message: "template variable has no value" },
    ]);
  });
});

describe("semver comparison", () => {
  it("orders versions numerically", () => {
    expect(compareSemver("0.9.9", "0.10.0")).toBeLessThan(0);
    expect(compareSemver("1.2.3", "1.2.3")).toBe(0);
    expect(compareSemver("2.0.0", "1.99.99")).toBeGreaterThan(0);
  });
});
