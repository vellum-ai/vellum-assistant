import { describe, expect, test } from "bun:test";

import {
  coerceArrayShapes,
  coerceStringBooleans,
  validateInputAgainstSchema,
} from "../skills/validate-input.js";

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
    if (result.ok) {
      return;
    }
    expect(result.errors).toContain("surface_id is required");
    expect(result.errors).toContain("content is required");
  });

  test("treats present-but-undefined keys as present (JSON Schema spec)", () => {
    // JSON Schema `required` is presence-only — `{ surface_id: undefined }`
    // still has `"surface_id" in input` === true. The type/null skip in step
    // 2 covers the actual value handling.
    const result = validateInputAgainstSchema(
      "document_update",
      { surface_id: undefined, content: undefined },
      schema,
    );
    // No "required" errors since the keys are present.
    if (!result.ok) {
      expect(result.errors).not.toContain("surface_id is required");
      expect(result.errors).not.toContain("content is required");
    }
  });

  test("accepts explicit null for a required field (presence-only)", () => {
    // JSON Schema `required` does NOT forbid null — that's a type concern.
    // A custom/plugin schema with `type: ["string","null"]` would be valid;
    // the type check (step 2) is what gates null values, not required (step 1).
    const result = validateInputAgainstSchema(
      "document_update",
      { surface_id: "doc-1", content: null },
      // Use a schema where `content` allows null via union, so type-check skips it.
      {
        type: "object",
        properties: {
          surface_id: { type: "string" },
          content: { type: ["string", "null"] },
          mode: { type: "string" },
        },
        required: ["surface_id", "content"],
      },
    );
    expect(result).toEqual({ ok: true });
  });

  test("flags only truly absent keys, not explicit-undefined ones", () => {
    const result = validateInputAgainstSchema("document_update", {}, schema);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
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
    ["object", null, false], // null is a present value and fails single-type check
    ["string", null, false],
    ["number", null, false],
    ["integer", null, false],
    ["boolean", null, false],
    ["array", null, false],
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
// nullable / union-type handling (preserve plugin skills with nullable schemas)
// ---------------------------------------------------------------------------

describe("validateInputAgainstSchema — nullable / union types", () => {
  test("skips type check when `type` is an array union (e.g. ['string','null'])", () => {
    // Plugin / custom skills may declare `required: ["note"]` with
    // `type: ["string", "null"]`. Per the spec, `null` is a valid value.
    // We don't model union types, so we skip — never reject.
    const schema = {
      type: "object",
      properties: {
        note: { type: ["string", "null"] },
      },
      required: ["note"],
    };
    const nullResult = validateInputAgainstSchema("t", { note: null }, schema);
    expect(nullResult).toEqual({ ok: true });

    const stringResult = validateInputAgainstSchema(
      "t",
      { note: "hello" },
      schema,
    );
    expect(stringResult).toEqual({ ok: true });
  });

  test("rejects null for single non-null type but presence-check still passes", () => {
    // `type: "string"` does NOT allow null — the type check fires. Only
    // union types (`["string","null"]`) bypass the single-type check. The
    // `required` check is presence-only, so it does NOT fire for null.
    const schema = {
      type: "object",
      properties: {
        note: { type: "string" },
      },
      required: ["note"],
    };
    const result = validateInputAgainstSchema("t", { note: null }, schema);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.errors).toContain("note must be a string");
    expect(result.errors).not.toContain("note is required");
  });

  test("document_update({ content: null }) is rejected at the factory layer", () => {
    // Codex's example: a tool call supplying `null` for a non-nullable string
    // field should be rejected by the central validator, not passed through
    // to the downstream tool/proxy.
    const schema = {
      type: "object",
      properties: {
        surface_id: { type: "string" },
        content: { type: "string" },
        mode: { type: "string" },
      },
      required: ["surface_id", "content"],
    };
    const result = validateInputAgainstSchema(
      "document_update",
      { surface_id: "x", content: null },
      schema,
    );
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.errors).toContain("content must be a string");
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
    if (result.ok) {
      return;
    }
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
    if (result.ok) {
      return;
    }
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
    if (result.ok) {
      return;
    }
    expect(result.errors).toContain(
      'Unknown parameter "foo". Supported: "surface_id", "content", "mode"',
    );
  });

  test("flags multiple unknown keys individually", () => {
    const result = validateInputAgainstSchema("t", { foo: 1, bar: 2 }, schema);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
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
// string-boolean coercion (pre-validation pass)
// ---------------------------------------------------------------------------

describe("coerceStringBooleans", () => {
  const schema = {
    type: "object",
    properties: {
      auto_open: { type: "boolean" },
      name: { type: "string" },
      flags: { type: ["boolean", "null"] },
    },
  };

  test.each([
    ["false", false],
    ["true", true],
    ["False", false],
    ["TRUE", true],
    [" true ", true],
  ] as const)("coerces %p to %p for boolean-typed properties", (raw, want) => {
    const result = coerceStringBooleans({ auto_open: raw }, schema);
    expect(result.auto_open).toBe(want);
  });

  test("coerced input passes validation and preserves intent", () => {
    const coerced = coerceStringBooleans(
      { auto_open: "false", name: "x" },
      schema,
    );
    expect(validateInputAgainstSchema("app_create", coerced, schema)).toEqual({
      ok: true,
    });
    expect(coerced.auto_open).toBe(false);
  });

  test("leaves non-coercible strings alone (validation still rejects)", () => {
    const input = { auto_open: "yes" };
    const result = coerceStringBooleans(input, schema);
    expect(result).toBe(input);
    const validation = validateInputAgainstSchema("app_create", result, schema);
    expect(validation.ok).toBe(false);
  });

  test("does not touch string-typed or union-typed properties", () => {
    const input = { name: "true", flags: "false" };
    const result = coerceStringBooleans(input, schema);
    expect(result).toBe(input);
    expect(result.name).toBe("true");
    expect(result.flags).toBe("false");
  });

  test("does not touch real booleans or other types", () => {
    const input = { auto_open: true };
    expect(coerceStringBooleans(input, schema)).toBe(input);
    const inputNum = { auto_open: 1 };
    expect(coerceStringBooleans(inputNum, schema)).toBe(inputNum);
  });

  test("returns the same object when there is nothing to coerce", () => {
    const input = { name: "x" };
    expect(coerceStringBooleans(input, schema)).toBe(input);
    expect(coerceStringBooleans(input, undefined)).toBe(input);
    expect(coerceStringBooleans(input, { type: "object" })).toBe(input);
  });

  test("returns a new object and never mutates the original input", () => {
    const input = { auto_open: "false", name: "x" };
    const snapshot = JSON.parse(JSON.stringify(input));
    const result = coerceStringBooleans(input, schema);
    expect(result).not.toBe(input);
    expect(input).toEqual(snapshot);
    expect(result.name).toBe("x");
  });
});

describe("coerceArrayShapes", () => {
  const schema = {
    type: "object",
    properties: {
      activation_hints: { type: "array", items: { type: "string" } },
      files: {
        type: "array",
        items: {
          type: "object",
          properties: {
            path: { type: "string" },
            content: { type: "string" },
            copy_from: { type: "string" },
          },
          required: ["path"],
        },
      },
      steps: {
        type: "array",
        items: {
          type: "object",
          properties: {
            action: { type: "string" },
            require_approval: { type: "boolean" },
          },
        },
      },
      name: { type: "string" },
      tags: { type: ["array", "null"] },
      untyped: { type: "array" },
    },
  };

  describe("a string holding the JSON text of the array", () => {
    test("decodes an array of strings", () => {
      const result = coerceArrayShapes(
        { activation_hints: '["deploy staging","roll back"]' },
        schema,
      );
      expect(result.activation_hints).toEqual(["deploy staging", "roll back"]);
    });

    test("decodes an array of objects", () => {
      const result = coerceArrayShapes(
        { files: '[{"path":"references/notes.md","content":"hi"}]' },
        schema,
      );
      expect(result.files).toEqual([
        { path: "references/notes.md", content: "hi" },
      ]);
    });

    test("decodes for an array property that declares no item type", () => {
      const result = coerceArrayShapes({ untyped: '["a"]' }, schema);
      expect(result.untyped).toEqual(["a"]);
    });
  });

  describe("a single element where a list was expected", () => {
    test("wraps a bare phrase for a string-item array", () => {
      const result = coerceArrayShapes(
        { activation_hints: "user asks to deploy staging" },
        schema,
      );
      expect(result.activation_hints).toEqual(["user asks to deploy staging"]);
    });

    test("wraps the decoded text of a JSON-quoted phrase", () => {
      const result = coerceArrayShapes(
        { activation_hints: '"user asks to deploy staging"' },
        schema,
      );
      expect(result.activation_hints).toEqual(["user asks to deploy staging"]);
    });

    test("wraps one object that spells out the item schema's properties", () => {
      const result = coerceArrayShapes(
        { files: { path: "references/notes.md", content: "hi" } },
        schema,
      );
      expect(result.files).toEqual([
        { path: "references/notes.md", content: "hi" },
      ]);
    });

    test("leaves an object keyed by something the item schema does not name", () => {
      const input = { files: { "references/notes.md": "hi" } };
      const result = coerceArrayShapes(input, schema);
      expect(result).toBe(input);
    });

    test("leaves a bare phrase for an object-item array", () => {
      const input = { files: "references/notes.md" };
      const result = coerceArrayShapes(input, schema);
      expect(result).toBe(input);
    });

    test("leaves a bare phrase when the array declares no item type", () => {
      const input = { untyped: "one thing" };
      expect(coerceArrayShapes(input, schema)).toBe(input);
    });
  });

  describe("shapes left for the validator to reject", () => {
    test.each([
      ['["deploy staging"', "a truncated array"],
      ['{"path":"references/notes.md"', "a truncated object"],
      ["", "an empty string"],
      ["   ", "blank text"],
    ])("leaves %p (%s)", (raw) => {
      const input = { activation_hints: raw };
      const result = coerceArrayShapes(input, schema);
      expect(result).toBe(input);
      const validation = validateInputAgainstSchema(
        "scaffold_managed_skill",
        result,
        schema,
      );
      expect(validation.ok).toBe(false);
    });
  });

  test("repaired input passes validation and preserves intent", () => {
    const coerced = coerceArrayShapes(
      {
        activation_hints: "user asks to deploy staging",
        files: { path: "references/notes.md", content: "hi" },
        name: "x",
      },
      schema,
    );
    expect(
      validateInputAgainstSchema("scaffold_managed_skill", coerced, schema),
    ).toEqual({ ok: true });
    expect(coerced.activation_hints).toEqual(["user asks to deploy staging"]);
  });

  describe("elements an array gains here", () => {
    test("are coerced against the item schema when decoded", () => {
      const result = coerceArrayShapes(
        { steps: '[{"action":"send","require_approval":"false"}]' },
        schema,
      );
      expect(result.steps).toEqual([
        { action: "send", require_approval: false },
      ]);
    });

    test("are coerced against the item schema when wrapped", () => {
      const result = coerceArrayShapes(
        { steps: { action: "send", require_approval: "true" } },
        schema,
      );
      expect(result.steps).toEqual([
        { action: "send", require_approval: true },
      ]);
    });

    test("leave non-object elements alone", () => {
      const result = coerceArrayShapes({ steps: '["send",7]' }, schema);
      expect(result.steps).toEqual(["send", 7]);
    });
  });

  test("still reports a wrong element type after repair", () => {
    const coerced = coerceArrayShapes(
      { activation_hints: '["deploy staging",7]' },
      schema,
    );
    const validation = validateInputAgainstSchema(
      "scaffold_managed_skill",
      coerced,
      schema,
    );
    expect(validation.ok).toBe(false);
    if (validation.ok) {
      return;
    }
    expect(validation.errors).toContain("activation_hints[1] must be a string");
  });

  test("does not touch non-array-typed or union-typed properties", () => {
    const input = { name: '["x"]', tags: '["x"]' };
    const result = coerceArrayShapes(input, schema);
    expect(result).toBe(input);
    expect(result.name).toBe('["x"]');
    expect(result.tags).toBe('["x"]');
  });

  test("does not touch real arrays or other types", () => {
    const input = { activation_hints: ["deploy staging"] };
    expect(coerceArrayShapes(input, schema)).toBe(input);
    const inputNum = { activation_hints: 7 };
    expect(coerceArrayShapes(inputNum, schema)).toBe(inputNum);
  });

  test("returns the same object when there is nothing to repair", () => {
    const input = { name: "x" };
    expect(coerceArrayShapes(input, schema)).toBe(input);
    expect(coerceArrayShapes(input, undefined)).toBe(input);
    expect(coerceArrayShapes(input, { type: "object" })).toBe(input);
  });

  test("returns a new object and never mutates the original input", () => {
    const input = { activation_hints: '["deploy staging"]', name: "x" };
    const snapshot = JSON.parse(JSON.stringify(input));
    const result = coerceArrayShapes(input, schema);
    expect(result).not.toBe(input);
    expect(input).toEqual(snapshot);
    expect(result.name).toBe("x");
  });
});

describe("validateInputAgainstSchema: array shape error message", () => {
  const schema = {
    type: "object",
    properties: {
      activation_hints: { type: "array", items: { type: "string" } },
    },
  };

  test("points at the JSON array form when a string is passed", () => {
    const result = validateInputAgainstSchema(
      "scaffold_managed_skill",
      { activation_hints: "[deploy staging" },
      schema,
    );
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.errors).toEqual([
      "activation_hints must be an array: pass a JSON array, not a string",
    ]);
  });

  test("names an object when an object is passed", () => {
    const result = validateInputAgainstSchema(
      "scaffold_managed_skill",
      { activation_hints: { first: "deploy staging" } },
      schema,
    );
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.errors).toEqual([
      "activation_hints must be an array: pass a JSON array, not an object",
    ]);
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
