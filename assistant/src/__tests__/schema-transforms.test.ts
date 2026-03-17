import { describe, expect, test } from "bun:test";

import type { ToolDefinition } from "../providers/types.js";
import {
  injectActivityField,
  ACTIVITY_SKIP_SET,
  schemaDefinesProperty,
} from "../tools/schema-transforms.js";

function makeDef(
  name: string,
  schema: object = { type: "object", properties: {}, required: [] },
): ToolDefinition {
  return { name, description: `Tool ${name}`, input_schema: schema };
}

describe("ACTIVITY_SKIP_SET", () => {
  test("contains expected tool names", () => {
    expect(ACTIVITY_SKIP_SET.has("skill_execute")).toBe(true);
    expect(ACTIVITY_SKIP_SET.has("bash")).toBe(true);
    expect(ACTIVITY_SKIP_SET.has("host_bash")).toBe(true);
    expect(ACTIVITY_SKIP_SET.has("request_system_permission")).toBe(true);
    expect(ACTIVITY_SKIP_SET.size).toBe(4);
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
    const result = injectActivityField(defs);
    // Should be the exact same object references
    expect(Object.is(result[0], defs[0])).toBe(true);
    expect(Object.is(result[1], defs[1])).toBe(true);
    // No activity injected
    const schema0 = result[0].input_schema as Record<string, unknown>;
    const props0 = schema0.properties as Record<string, unknown>;
    expect("activity" in props0).toBe(false);
  });

  test("skips tools that already have activity in properties", () => {
    const defs = [
      makeDef("my_tool", {
        type: "object",
        properties: { activity: { type: "number" } },
        required: [],
      }),
    ];
    const result = injectActivityField(defs);
    // Should be the exact same object reference (no clone needed)
    expect(Object.is(result[0], defs[0])).toBe(true);
    const schema = result[0].input_schema as Record<string, unknown>;
    const props = schema.properties as Record<string, unknown>;
    // Original activity type preserved
    expect(props.activity).toEqual({ type: "number" });
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
    // Should be the exact same object reference (no injection)
    expect(Object.is(result[0], defs[0])).toBe(true);
    const schema = result[0].input_schema as Record<string, unknown>;
    const props = schema.properties as Record<string, unknown>;
    // Top-level properties should NOT have activity injected
    expect("activity" in props).toBe(false);
  });

  test("handles empty definitions array", () => {
    const result = injectActivityField([]);
    expect(result).toEqual([]);
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

  test("returns false for $ref (fail-closed)", () => {
    const schema = { $ref: "#/definitions/Foo" };
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
