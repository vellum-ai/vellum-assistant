import { describe, expect, test } from "bun:test";

import { validateInputAgainstSchema } from "../skills/validate-input.js";

// ---------------------------------------------------------------------------
// required
// ---------------------------------------------------------------------------

describe("validateInputAgainstSchema — required", () => {
  const schema = {
    type: "object",
    properties: {
      surface_id: { type: "string" },
      content: { type: "string" },
      mode: { type: "string" },
    },
    required: ["surface_id", "content"],
  };

  test("succeeds when all required fields are present", () => {
    const result = validateInputAgainstSchema(
      "document_update",
      { surface_id: "doc-1", content: "hi" },
      schema,
    );
    expect(result).toEqual({ ok: true });
  });

  test("lists each missing required field individually", () => {
    const result = validateInputAgainstSchema("document_update", {}, schema);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContain("surface_id is required");
    expect(result.errors).toContain("content is required");
  });

  test("treats explicit undefined / null as missing", () => {
    const result = validateInputAgainstSchema(
      "document_update",
      { surface_id: undefined, content: null },
      schema,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContain("surface_id is required");
    expect(result.errors).toContain("content is required");
  });

  test("empty input is allowed when nothing is required", () => {
    const schemaNoRequired = {
      type: "object",
      properties: { query: { type: "string" } },
    };
    const result = validateInputAgainstSchema("noop", {}, schemaNoRequired);
    expect(result).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// type checks
// ---------------------------------------------------------------------------

describe("validateInputAgainstSchema — type checks", () => {
  test.each([
    ["string", "hello", true],
    ["string", 5, false],
    ["number", 3.14, true],
    ["number", "3.14", false],
    ["integer", 7, true],
    ["integer", 7.5, false],
    ["integer", "7", false],
    ["boolean", true, true],
    ["boolean", "true", false],
    ["array", [1, 2], true],
    ["array", { 0: 1 }, false],
    ["object", { a: 1 }, true],
    ["object", [1, 2], false],
    ["object", null, true], // null is skipped (treated as absent)
  ] as const)("type=%s, value=%p, valid=%p", (type, value, valid) => {
    const result = validateInputAgainstSchema(
      "t",
      { field: value },
      { type: "object", properties: { field: { type } } },
    );
    expect(result.ok).toBe(valid);
    if (!valid) {
      expect((result as { ok: false; errors: string[] }).errors[0]).toContain(
        `field must be `,
      );
      expect((result as { ok: false; errors: string[] }).errors[0]).toContain(
        type,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// enum
// ---------------------------------------------------------------------------

describe("validateInputAgainstSchema — enum", () => {
  const schema = {
    type: "object",
    properties: {
      mode: { type: "string", enum: ["replace", "append"] },
    },
  };

  test("succeeds for a valid enum value", () => {
    const result = validateInputAgainstSchema("t", { mode: "replace" }, schema);
    expect(result).toEqual({ ok: true });
  });

  test("fails with the list of allowed values", () => {
    const result = validateInputAgainstSchema("t", { mode: "bogus" }, schema);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContain('mode must be one of "replace", "append"');
  });
});

// ---------------------------------------------------------------------------
// array items
// ---------------------------------------------------------------------------

describe("validateInputAgainstSchema — array items", () => {
  const schema = {
    type: "object",
    properties: {
      tags: { type: "array", items: { type: "string" } },
    },
  };

  test("succeeds when every element matches", () => {
    const result = validateInputAgainstSchema(
      "t",
      { tags: ["a", "b"] },
      schema,
    );
    expect(result).toEqual({ ok: true });
  });

  test("flags each element that violates the item type", () => {
    const result = validateInputAgainstSchema(
      "t",
      { tags: ["a", 2, "c", false] },
      schema,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContain("tags[1] must be a string");
    expect(result.errors).toContain("tags[3] must be a string");
    expect(result.errors).not.toContain("tags[0] must be a string");
    expect(result.errors).not.toContain("tags[2] must be a string");
  });
});

// ---------------------------------------------------------------------------
// unknown keys
// ---------------------------------------------------------------------------

describe("validateInputAgainstSchema — unknown keys", () => {
  const schema = {
    type: "object",
    properties: {
      surface_id: { type: "string" },
      content: { type: "string" },
      mode: { type: "string" },
    },
  };

  test("flags a single unknown key with the supported list", () => {
    const result = validateInputAgainstSchema(
      "t",
      { surface_id: "doc", content: "x", foo: 1 },
      schema,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContain(
      'Unknown parameter "foo". Supported: "surface_id", "content", "mode"',
    );
  });

  test("flags multiple unknown keys individually", () => {
    const result = validateInputAgainstSchema("t", { foo: 1, bar: 2 }, schema);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const unknownErrors = result.errors.filter((e) =>
      e.startsWith("Unknown parameter"),
    );
    expect(unknownErrors).toHaveLength(2);
    expect(unknownErrors.some((e) => e.includes('"foo"'))).toBe(true);
    expect(unknownErrors.some((e) => e.includes('"bar"'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// permissive paths
// ---------------------------------------------------------------------------

describe("validateInputAgainstSchema — permissive paths", () => {
  test("permits anything when schema is undefined", () => {
    const result = validateInputAgainstSchema(
      "t",
      { whatever: "goes" },
      undefined,
    );
    expect(result).toEqual({ ok: true });
  });

  test("permits anything when schema has no properties", () => {
    const result = validateInputAgainstSchema(
      "t",
      { anything: 1 },
      { type: "object" },
    );
    expect(result).toEqual({ ok: true });
  });

  test("does not throw when schema contains oneOf / $ref keywords", () => {
    const schema = {
      type: "object",
      properties: {
        field: {
          $ref: "#/definitions/Thing",
          oneOf: [{ type: "string" }, { type: "number" }],
        },
      },
    };
    let result: ReturnType<typeof validateInputAgainstSchema>;
    expect(() => {
      result = validateInputAgainstSchema("t", { field: "x" }, schema);
    }).not.toThrow();
    expect(result!.ok).toBe(true);
  });

  test("does not throw when top-level schema contains anyOf / allOf", () => {
    const schema = {
      type: "object",
      properties: { field: { type: "string" } },
      anyOf: [{ required: ["field"] }],
      allOf: [{ type: "object" }],
    };
    expect(() =>
      validateInputAgainstSchema("t", { field: "x" }, schema),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// purity
// ---------------------------------------------------------------------------

describe("validateInputAgainstSchema — purity", () => {
  test("does not mutate the input or the schema", () => {
    const input = { surface_id: "doc", content: "hi", extra: 1 };
    const schema = {
      type: "object",
      properties: {
        surface_id: { type: "string" },
        content: { type: "string" },
      },
      required: ["surface_id"],
    };
    const inputSnapshot = JSON.parse(JSON.stringify(input));
    const schemaSnapshot = JSON.parse(JSON.stringify(schema));

    validateInputAgainstSchema("t", input, schema);

    expect(input).toEqual(inputSnapshot);
    expect(schema).toEqual(schemaSnapshot);
  });
});
