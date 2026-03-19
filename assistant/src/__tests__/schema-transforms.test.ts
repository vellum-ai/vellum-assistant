import { describe, expect, test } from "bun:test";

import type { ToolDefinition } from "../providers/types.js";
import {
  ACTIVITY_SKIP_SET,
  injectActivityField,
  schemaDefinesProperty,
} from "../tools/schema-transforms.js";

function makeDef(
  name: string,
  schema: object = { type: "object", properties: {}, required: [] },
): ToolDefinition {
  return { name, description: `Tool ${name}`, input_schema: schema };
}

describe("ACTIVITY_SKIP_SET", () => {
  test("is empty (all tools now define their own activity property)", () => {
    expect(ACTIVITY_SKIP_SET.size).toBe(0);
  });
});

describe("injectActivityField", () => {
  test("injects activity on a tool without it", () => {
    const defs = [makeDef("my_tool")];
    const result = injectActivityField(defs);
    const schema = result[0].input_schema as Record<string, unknown>;
    const props = schema.properties as Record<string, unknown>;
    expect(props.activity).toEqual({
      type: "string",
      description:
        "Brief, natural description of what you're doing, shown as a live status update (e.g. 'Checking your project settings')",
    });
  });

  test("adds activity to required array", () => {
    const defs = [
      makeDef("my_tool", {
        type: "object",
        properties: { foo: { type: "string" } },
        required: ["foo"],
      }),
    ];
    const result = injectActivityField(defs);
    const schema = result[0].input_schema as Record<string, unknown>;
    expect(schema.required).toEqual(["foo", "activity"]);
  });

  test("creates required array if missing", () => {
    const defs = [
      makeDef("my_tool", {
        type: "object",
        properties: { foo: { type: "string" } },
      }),
    ];
    const result = injectActivityField(defs);
    const schema = result[0].input_schema as Record<string, unknown>;
    expect(schema.required).toEqual(["activity"]);
  });

  test("skips tools in skip set (returns unchanged)", () => {
    const defs = [makeDef("bash"), makeDef("host_bash")];
    const result = injectActivityField(defs, new Set(["bash", "host_bash"]));
    // Should be the exact same object references
    expect(Object.is(result[0], defs[0])).toBe(true);
    expect(Object.is(result[1], defs[1])).toBe(true);
    // No activity injected
    const schema0 = result[0].input_schema as Record<string, unknown>;
    const props0 = schema0.properties as Record<string, unknown>;
    expect("activity" in props0).toBe(false);
  });

  test("adds activity to required when already in top-level properties but not required", () => {
    const defs = [
      makeDef("my_tool", {
        type: "object",
        properties: { activity: { type: "number" } },
        required: ["foo"],
      }),
    ];
    const result = injectActivityField(defs);
    const schema = result[0].input_schema as Record<string, unknown>;
    const props = schema.properties as Record<string, unknown>;
    // Original activity type preserved (no overwrite)
    expect(props.activity).toEqual({ type: "number" });
    // activity added to required
    expect(schema.required).toEqual(["foo", "activity"]);
  });

  test("returns unchanged when activity is in both top-level properties AND required", () => {
    const defs = [
      makeDef("my_tool", {
        type: "object",
        properties: { activity: { type: "string" } },
        required: ["activity"],
      }),
    ];
    const result = injectActivityField(defs);
    const schema = result[0].input_schema as Record<string, unknown>;
    const props = schema.properties as Record<string, unknown>;
    // Original activity type preserved
    expect(props.activity).toEqual({ type: "string" });
    // activity must be in required even though it was already in properties
    expect(schema.required).toEqual(["activity"]);
  });

  test("skips tools that already have activity in both properties and required", () => {
    const defs = [
      makeDef("my_tool", {
        type: "object",
        properties: { activity: { type: "number" } },
        required: ["activity"],
      }),
    ];
    const result = injectActivityField(defs);
    // Should be the exact same object reference (no clone needed)
    expect(Object.is(result[0], defs[0])).toBe(true);
  });

  test("does NOT mutate original definition objects", () => {
    const originalProps = { foo: { type: "string" } };
    const originalRequired = ["foo"];
    const originalSchema = {
      type: "object",
      properties: originalProps,
      required: originalRequired,
    };
    const defs = [makeDef("my_tool", originalSchema)];

    const result = injectActivityField(defs);

    // Original properties object is untouched
    expect("activity" in originalProps).toBe(false);
    // Original required array is untouched
    expect(originalRequired).toEqual(["foo"]);
    // Original schema properties ref is the same object
    expect(Object.is(originalSchema.properties, originalProps)).toBe(true);

    // Result has different object refs
    const resultSchema = result[0].input_schema as Record<string, unknown>;
    expect(Object.is(resultSchema, originalSchema)).toBe(false);
    expect(Object.is(resultSchema.properties, originalProps)).toBe(false);
    expect(Object.is(resultSchema.required, originalRequired)).toBe(false);
  });

  test("passes through non-object schemas unchanged", () => {
    const defs = [makeDef("my_tool", { type: "string" })];
    const result = injectActivityField(defs);
    expect(Object.is(result[0], defs[0])).toBe(true);
  });

  test("passes through schemas without properties unchanged", () => {
    const defs = [makeDef("my_tool", { type: "object" })];
    const result = injectActivityField(defs);
    expect(Object.is(result[0], defs[0])).toBe(true);
  });

  test("does NOT add activity to top-level required when only in oneOf branch", () => {
    const defs = [
      makeDef("my_tool", {
        type: "object",
        properties: { shared: { type: "string" } },
        oneOf: [
          {
            properties: {
              activity: { type: "string" },
              branch_a: { type: "number" },
            },
          },
          {
            properties: { branch_b: { type: "boolean" } },
          },
        ],
        required: ["shared"],
      }),
    ];
    const result = injectActivityField(defs);
    // Should be the exact same object reference (no modification)
    expect(Object.is(result[0], defs[0])).toBe(true);
    const schema = result[0].input_schema as Record<string, unknown>;
    // Top-level required should NOT include activity
    expect(schema.required).toEqual(["shared"]);
    // Top-level properties should NOT have activity injected
    const props = schema.properties as Record<string, unknown>;
    expect("activity" in props).toBe(false);
  });

  test("does NOT add activity to top-level required when only in allOf sub-schema with additionalProperties: false", () => {
    const defs = [
      makeDef("my_tool", {
        type: "object",
        properties: { foo: { type: "string" } },
        additionalProperties: false,
        allOf: [
          {
            properties: { activity: { type: "string" } },
          },
        ],
        required: ["foo"],
      }),
    ];
    const result = injectActivityField(defs);
    // Should be the exact same object reference (no modification)
    expect(Object.is(result[0], defs[0])).toBe(true);
    const schema = result[0].input_schema as Record<string, unknown>;
    // Top-level required should NOT include activity
    expect(schema.required).toEqual(["foo"]);
    const props = schema.properties as Record<string, unknown>;
    expect("activity" in props).toBe(false);
  });

  test("skips tools with activity defined inside allOf member (composite schema)", () => {
    const defs = [
      makeDef("my_tool", {
        type: "object",
        properties: { foo: { type: "string" } },
        allOf: [
          {
            properties: { activity: { type: "string" } },
          },
        ],
        required: [],
      }),
    ];
    const result = injectActivityField(defs);
    // Should be the exact same object reference (no modification)
    expect(Object.is(result[0], defs[0])).toBe(true);
    const schema = result[0].input_schema as Record<string, unknown>;
    const props = schema.properties as Record<string, unknown>;
    // Top-level properties should NOT have activity injected (it's in allOf)
    expect("activity" in props).toBe(false);
    // Top-level required should NOT include activity (it's only in composite sub-schemas)
    expect(schema.required).toEqual([]);
  });

  test("skips allOf composite schema where activity is already required", () => {
    const defs = [
      makeDef("my_tool", {
        type: "object",
        properties: { foo: { type: "string" } },
        allOf: [
          {
            properties: { activity: { type: "string" } },
          },
        ],
        required: ["activity"],
      }),
    ];
    const result = injectActivityField(defs);
    // Should be the exact same object reference (no change needed)
    expect(Object.is(result[0], defs[0])).toBe(true);
  });

  test("handles empty definitions array", () => {
    const result = injectActivityField([]);
    expect(result).toEqual([]);
  });

  test("every tool with object schema has activity in required after injection", () => {
    // Regression test: if a tool defines `activity` in its properties but
    // omits it from `required`, injectActivityField() skips that tool
    // (because schemaDefinesProperty returns true), leaving `activity`
    // optional. This test catches that scenario.
    const defs = [
      // Normal tool without activity — should get it injected
      makeDef("tool_a", {
        type: "object",
        properties: { foo: { type: "string" } },
        required: ["foo"],
      }),
      // BUG SCENARIO: tool defines activity in properties but NOT in required
      makeDef("tool_b", {
        type: "object",
        properties: {
          bar: { type: "string" },
          activity: { type: "string", description: "custom activity" },
        },
        required: ["bar"],
      }),
      // Tool that correctly defines activity in both properties AND required
      makeDef("tool_c", {
        type: "object",
        properties: {
          baz: { type: "number" },
          activity: { type: "string", description: "custom activity" },
        },
        required: ["baz", "activity"],
      }),
      // Non-object schema — should be left alone
      makeDef("tool_d", { type: "string" }),
      // Object schema without properties — should be left alone
      makeDef("tool_e", { type: "object" }),
    ];

    const result = injectActivityField(defs);

    for (const def of result) {
      const schema = def.input_schema as Record<string, unknown>;
      if (schema.type !== "object" || !schema.properties) continue;

      const required = schema.required;
      expect(Array.isArray(required) && required.includes("activity")).toBe(
        true,
      );
    }
  });
});

describe("schemaDefinesProperty", () => {
  test("returns true for direct properties match", () => {
    const schema = {
      type: "object",
      properties: { activity: { type: "string" } },
    };
    expect(schemaDefinesProperty(schema, "activity")).toBe(true);
  });

  test("returns true for property in allOf member", () => {
    const schema = {
      allOf: [{ properties: { activity: { type: "string" } } }],
    };
    expect(schemaDefinesProperty(schema, "activity")).toBe(true);
  });

  test("returns true for property in oneOf member", () => {
    const schema = {
      oneOf: [
        { properties: { foo: { type: "string" } } },
        { properties: { activity: { type: "string" } } },
      ],
    };
    expect(schemaDefinesProperty(schema, "activity")).toBe(true);
  });

  test("returns true for property in anyOf member", () => {
    const schema = {
      anyOf: [{ properties: { activity: { type: "string" } } }],
    };
    expect(schemaDefinesProperty(schema, "activity")).toBe(true);
  });

  test("returns true for nested allOf within oneOf", () => {
    const schema = {
      oneOf: [
        {
          allOf: [{ properties: { activity: { type: "string" } } }],
        },
      ],
    };
    expect(schemaDefinesProperty(schema, "activity")).toBe(true);
  });

  test("returns false when property not defined", () => {
    const schema = {
      type: "object",
      properties: { foo: { type: "string" } },
    };
    expect(schemaDefinesProperty(schema, "activity")).toBe(false);
  });

  test("returns false for $ref with default behavior (fail-closed)", () => {
    const schema = { $ref: "#/definitions/Foo" };
    expect(schemaDefinesProperty(schema, "activity")).toBe(false);
  });

  test("returns true for $ref with assume-defined behavior (fail-open)", () => {
    const schema = { $ref: "#/definitions/Foo" };
    expect(
      schemaDefinesProperty(schema, "activity", {
        refBehavior: "assume-defined",
      }),
    ).toBe(true);
  });

  test("returns true for $ref nested in allOf with assume-defined refBehavior", () => {
    const schema = {
      allOf: [{ $ref: "#/definitions/Foo" }],
    };
    expect(
      schemaDefinesProperty(schema, "activity", {
        refBehavior: "assume-defined",
      }),
    ).toBe(true);
  });

  test("returns false for $ref nested in allOf with assume-undefined refBehavior", () => {
    const schema = {
      allOf: [{ $ref: "#/definitions/Foo" }],
    };
    expect(
      schemaDefinesProperty(schema, "activity", {
        refBehavior: "assume-undefined",
      }),
    ).toBe(false);
  });

  test("returns true for $ref nested in oneOf with assume-defined refBehavior", () => {
    const schema = {
      oneOf: [{ $ref: "#/definitions/Foo" }],
    };
    expect(
      schemaDefinesProperty(schema, "activity", {
        refBehavior: "assume-defined",
      }),
    ).toBe(true);
  });

  test("returns true for $ref nested in anyOf with assume-defined refBehavior", () => {
    const schema = {
      anyOf: [{ $ref: "#/definitions/Foo" }],
    };
    expect(
      schemaDefinesProperty(schema, "activity", {
        refBehavior: "assume-defined",
      }),
    ).toBe(true);
  });

  test("returns false for $ref nested in allOf with default refBehavior (fail-closed)", () => {
    const schema = {
      allOf: [{ $ref: "#/definitions/Foo" }],
    };
    expect(schemaDefinesProperty(schema, "activity")).toBe(false);
  });

  test("returns false for null schema", () => {
    expect(schemaDefinesProperty(null, "activity")).toBe(false);
  });

  test("returns false for undefined schema", () => {
    expect(schemaDefinesProperty(undefined, "activity")).toBe(false);
  });

  test("returns false for non-object schema", () => {
    expect(schemaDefinesProperty("not-an-object", "activity")).toBe(false);
    expect(schemaDefinesProperty(42, "activity")).toBe(false);
    expect(schemaDefinesProperty(true, "activity")).toBe(false);
  });
});
