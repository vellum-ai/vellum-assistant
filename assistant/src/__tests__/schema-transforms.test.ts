import { describe, expect, test } from "bun:test";

import type { ToolDefinition } from "../providers/types.js";
import {
  injectReasonField,
  REASON_SKIP_SET,
  schemaDefinesProperty,
} from "../tools/schema-transforms.js";

function makeDef(
  name: string,
  schema: object = { type: "object", properties: {}, required: [] },
): ToolDefinition {
  return { name, description: `Tool ${name}`, input_schema: schema };
}

describe("REASON_SKIP_SET", () => {
  test("contains expected tool names", () => {
    expect(REASON_SKIP_SET.has("skill_execute")).toBe(true);
    expect(REASON_SKIP_SET.has("bash")).toBe(true);
    expect(REASON_SKIP_SET.has("host_bash")).toBe(true);
    expect(REASON_SKIP_SET.has("request_system_permission")).toBe(true);
    expect(REASON_SKIP_SET.size).toBe(4);
  });
});

describe("injectReasonField", () => {
  test("injects reason on a tool without it", () => {
    const defs = [makeDef("my_tool")];
    const result = injectReasonField(defs);
    const schema = result[0].input_schema as Record<string, unknown>;
    const props = schema.properties as Record<string, unknown>;
    expect(props.reason).toEqual({ type: "string" });
  });

  test("adds reason to required array", () => {
    const defs = [
      makeDef("my_tool", {
        type: "object",
        properties: { foo: { type: "string" } },
        required: ["foo"],
      }),
    ];
    const result = injectReasonField(defs);
    const schema = result[0].input_schema as Record<string, unknown>;
    expect(schema.required).toEqual(["foo", "reason"]);
  });

  test("creates required array if missing", () => {
    const defs = [
      makeDef("my_tool", {
        type: "object",
        properties: { foo: { type: "string" } },
      }),
    ];
    const result = injectReasonField(defs);
    const schema = result[0].input_schema as Record<string, unknown>;
    expect(schema.required).toEqual(["reason"]);
  });

  test("skips tools in skip set (returns unchanged)", () => {
    const defs = [makeDef("bash"), makeDef("host_bash")];
    const result = injectReasonField(defs);
    // Should be the exact same object references
    expect(Object.is(result[0], defs[0])).toBe(true);
    expect(Object.is(result[1], defs[1])).toBe(true);
    // No reason injected
    const schema0 = result[0].input_schema as Record<string, unknown>;
    const props0 = schema0.properties as Record<string, unknown>;
    expect("reason" in props0).toBe(false);
  });

  test("skips tools that already have reason in properties", () => {
    const defs = [
      makeDef("my_tool", {
        type: "object",
        properties: { reason: { type: "number" } },
        required: [],
      }),
    ];
    const result = injectReasonField(defs);
    // Should be the exact same object reference (no clone needed)
    expect(Object.is(result[0], defs[0])).toBe(true);
    const schema = result[0].input_schema as Record<string, unknown>;
    const props = schema.properties as Record<string, unknown>;
    // Original reason type preserved
    expect(props.reason).toEqual({ type: "number" });
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

    const result = injectReasonField(defs);

    // Original properties object is untouched
    expect("reason" in originalProps).toBe(false);
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
    const result = injectReasonField(defs);
    expect(Object.is(result[0], defs[0])).toBe(true);
  });

  test("passes through schemas without properties unchanged", () => {
    const defs = [makeDef("my_tool", { type: "object" })];
    const result = injectReasonField(defs);
    expect(Object.is(result[0], defs[0])).toBe(true);
  });

  test("skips tools with reason defined inside allOf member (composite schema)", () => {
    const defs = [
      makeDef("my_tool", {
        type: "object",
        properties: { foo: { type: "string" } },
        allOf: [
          {
            properties: { reason: { type: "string" } },
          },
        ],
        required: [],
      }),
    ];
    const result = injectReasonField(defs);
    // Should be the exact same object reference (no injection)
    expect(Object.is(result[0], defs[0])).toBe(true);
    const schema = result[0].input_schema as Record<string, unknown>;
    const props = schema.properties as Record<string, unknown>;
    // Top-level properties should NOT have reason injected
    expect("reason" in props).toBe(false);
  });

  test("handles empty definitions array", () => {
    const result = injectReasonField([]);
    expect(result).toEqual([]);
  });
});

describe("schemaDefinesProperty", () => {
  test("returns true for direct properties match", () => {
    const schema = {
      type: "object",
      properties: { reason: { type: "string" } },
    };
    expect(schemaDefinesProperty(schema, "reason")).toBe(true);
  });

  test("returns true for property in allOf member", () => {
    const schema = {
      allOf: [{ properties: { reason: { type: "string" } } }],
    };
    expect(schemaDefinesProperty(schema, "reason")).toBe(true);
  });

  test("returns true for property in oneOf member", () => {
    const schema = {
      oneOf: [
        { properties: { foo: { type: "string" } } },
        { properties: { reason: { type: "string" } } },
      ],
    };
    expect(schemaDefinesProperty(schema, "reason")).toBe(true);
  });

  test("returns true for property in anyOf member", () => {
    const schema = {
      anyOf: [{ properties: { reason: { type: "string" } } }],
    };
    expect(schemaDefinesProperty(schema, "reason")).toBe(true);
  });

  test("returns true for nested allOf within oneOf", () => {
    const schema = {
      oneOf: [
        {
          allOf: [{ properties: { reason: { type: "string" } } }],
        },
      ],
    };
    expect(schemaDefinesProperty(schema, "reason")).toBe(true);
  });

  test("returns false when property not defined", () => {
    const schema = {
      type: "object",
      properties: { foo: { type: "string" } },
    };
    expect(schemaDefinesProperty(schema, "reason")).toBe(false);
  });

  test("returns false for $ref (fail-closed)", () => {
    const schema = { $ref: "#/definitions/Foo" };
    expect(schemaDefinesProperty(schema, "reason")).toBe(false);
  });

  test("returns false for null schema", () => {
    expect(schemaDefinesProperty(null, "reason")).toBe(false);
  });

  test("returns false for undefined schema", () => {
    expect(schemaDefinesProperty(undefined, "reason")).toBe(false);
  });

  test("returns false for non-object schema", () => {
    expect(schemaDefinesProperty("not-an-object", "reason")).toBe(false);
    expect(schemaDefinesProperty(42, "reason")).toBe(false);
    expect(schemaDefinesProperty(true, "reason")).toBe(false);
  });
});
