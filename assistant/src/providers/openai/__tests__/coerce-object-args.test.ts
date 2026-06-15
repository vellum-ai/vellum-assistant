import { describe, expect, test } from "bun:test";

import {
  coerceObjectParamsToJsonString,
  decodeCoercedObjectArgs,
} from "../coerce-object-args.js";

const SKILL_EXECUTE_SCHEMA = {
  type: "object",
  properties: {
    tool: { type: "string", description: "The skill tool name" },
    input: { type: "object", description: "Tool-specific parameters" },
    activity: { type: "string", description: "Progress update" },
  },
  required: ["tool", "input", "activity"],
};

describe("coerceObjectParamsToJsonString", () => {
  test("rewrites object params to strings and reports the keys", () => {
    const { parameters, objectKeys } =
      coerceObjectParamsToJsonString(SKILL_EXECUTE_SCHEMA);

    expect(objectKeys).toEqual(["input"]);
    const props = (
      parameters as { properties: Record<string, { type: string }> }
    ).properties;
    expect(props.input.type).toBe("string");
    // Scalars are left untouched.
    expect(props.tool.type).toBe("string");
    expect(props.activity.type).toBe("string");
    // The required list is preserved.
    expect((parameters as { required: string[] }).required).toEqual([
      "tool",
      "input",
      "activity",
    ]);
  });

  test("leaves array and scalar params alone (no coercion)", () => {
    const schema = {
      type: "object",
      properties: {
        query: { type: "string" },
        sources: { type: "array", items: { type: "string" } },
      },
    };
    const { parameters, objectKeys } = coerceObjectParamsToJsonString(schema);
    expect(objectKeys).toEqual([]);
    expect(parameters).toEqual(schema);
  });

  test("handles type unions that include object", () => {
    const schema = {
      type: "object",
      properties: { data: { type: ["object", "null"] } },
    };
    const { objectKeys } = coerceObjectParamsToJsonString(schema);
    expect(objectKeys).toEqual(["data"]);
  });
});

describe("decodeCoercedObjectArgs", () => {
  test("round-trips a JSON-string object back into an object", () => {
    const { objectKeys } = coerceObjectParamsToJsonString(SKILL_EXECUTE_SCHEMA);
    // What minimax would send once `input` is a string param.
    const onWire = {
      tool: "app_delete",
      input: '{"app_id": "5ee3d2d5-46e8-4a79-928f-00a7471d340b"}',
      activity: "Delete placeholder",
    };
    const { input, failedKey } = decodeCoercedObjectArgs(onWire, objectKeys);
    expect(failedKey).toBeUndefined();
    expect(input.input).toEqual({
      app_id: "5ee3d2d5-46e8-4a79-928f-00a7471d340b",
    });
    // Scalars pass through unchanged.
    expect(input.tool).toBe("app_delete");
  });

  test("empty string decodes to an empty object", () => {
    const { input } = decodeCoercedObjectArgs({ input: "" }, ["input"]);
    expect(input.input).toEqual({});
  });

  test("is idempotent when the value is already an object", () => {
    const args = { input: { app_id: "x" } };
    const { input, failedKey } = decodeCoercedObjectArgs(args, ["input"]);
    expect(failedKey).toBeUndefined();
    expect(input.input).toEqual({ app_id: "x" });
  });

  test("reports failedKey on invalid JSON instead of throwing", () => {
    const { failedKey } = decodeCoercedObjectArgs(
      { input: "{not valid json" },
      ["input"],
    );
    expect(failedKey).toBe("input");
  });

  test("no-op when there are no coerced keys", () => {
    const args = { tool: "x", input: "{}" };
    const { input } = decodeCoercedObjectArgs(args, []);
    expect(input).toEqual(args);
  });
});
