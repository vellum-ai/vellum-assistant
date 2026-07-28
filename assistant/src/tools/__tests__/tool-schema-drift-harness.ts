import { expect } from "bun:test";

/**
 * Shared assertion harness for the per-skill TOOLS.json ↔ runtime Zod schema
 * drift guards (`schedule-tool-input-schemas.test.ts`,
 * `document-tool-input-schemas.test.ts`, …). Skill-owned tools are skipped by
 * the central `TOOL_INPUT_SCHEMAS` gate, so the advertised contract
 * (hand-written TOOLS.json) and the runtime validation (Zod schema in the
 * executor module) live in different files; these helpers pin their STRUCTURE
 * (property names, types, enums, required lists) together so a field added or
 * retyped on one side cannot silently diverge on the other.
 *
 * What is deliberately NOT compared:
 *
 * - `description` strings — advertised prose is TOOLS.json-owned; the runtime
 *   schema never reads it.
 * - `passthrough` fields — advertised in TOOLS.json but undeclared in the Zod
 *   schema (loose passthrough), because the executor's bespoke handling is the
 *   validation contract. Each entry documents why. The harness still asserts
 *   they exist in TOOLS.json (and are absent from the derived schema), so a
 *   rename breaks the test.
 * - `nullableAtRuntime` fields — declared `.nullable()` in the Zod schema
 *   though advertised non-null (runtime-only tolerance); compared with the
 *   null branch stripped so the slack is not advertised.
 *
 * This file is imported by test files at test time (after the preload's
 * workspace override), and deliberately imports nothing from `src/` — callers
 * pass in the already-derived JSON schema.
 */

export type JsonSchema = Record<string, unknown>;

export interface DriftCase {
  /** Tool name, matched against the TOOLS.json `tools[].name`. */
  name: string;
  /** `toToolInputSchema(...)` output for the tool's runtime Zod schema. */
  derived: JsonSchema;
  /** Advertised fields the runtime schema passes through unvalidated. */
  passthrough?: Record<string, string>;
  /** Declared fields that additionally accept null at runtime. */
  nullableAtRuntime?: string[];
}

/** Strip `description` keys recursively — prose is TOOLS.json-owned. */
function structural(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map(structural);
  }
  if (node === null || typeof node !== "object") {
    return node;
  }
  const out: JsonSchema = {};
  for (const [key, value] of Object.entries(node as JsonSchema)) {
    if (key === "description") {
      continue;
    }
    out[key] = structural(value);
  }
  return out;
}

/**
 * Canonicalize a derived property schema for comparison with TOOLS.json's
 * hand-written form:
 *
 * - drop the safe-integer `minimum`/`maximum` bounds `z.int()` emits;
 * - drop the empty `properties` block `z.looseObject({})` (an "any object"
 *   passthrough) emits that TOOLS.json's bare `{type: "object"}` doesn't;
 * - collapse `anyOf: [X, {type: "null"}]` (Zod's nullable encoding) into
 *   TOOLS.json's `type: [t, "null"]` array form;
 * - when `stripNull` is set (`nullableAtRuntime` fields), drop the null
 *   branch entirely so the runtime-only null tolerance is not advertised.
 */
function canonicalize(prop: JsonSchema, stripNull: boolean): JsonSchema {
  const out = { ...prop };
  if (out.minimum === -(2 ** 53 - 1)) {
    delete out.minimum;
  }
  if (out.maximum === 2 ** 53 - 1) {
    delete out.maximum;
  }
  if (
    typeof out.properties === "object" &&
    out.properties !== null &&
    Object.keys(out.properties).length === 0
  ) {
    delete out.properties;
  }
  const anyOf = out.anyOf;
  if (Array.isArray(anyOf) && anyOf.length === 2) {
    const nullIdx = anyOf.findIndex(
      (entry) => (entry as JsonSchema).type === "null",
    );
    if (nullIdx !== -1) {
      const base = canonicalize(anyOf[1 - nullIdx] as JsonSchema, false);
      delete out.anyOf;
      Object.assign(out, base);
      if (!stripNull && typeof base.type === "string") {
        out.type = [base.type, "null"];
      }
    }
  }
  return out;
}

/**
 * Assert one tool's derived runtime schema structurally matches its advertised
 * TOOLS.json `input_schema`, modulo the documented exceptions above.
 */
export function expectNoSchemaDrift(
  c: DriftCase,
  toolsJson: { tools: { name: string; input_schema: JsonSchema }[] },
): void {
  const entry = toolsJson.tools.find((t) => t.name === c.name);
  expect(entry).toBeDefined();
  const advertised = structural(entry!.input_schema) as JsonSchema;
  const derived = structural(c.derived) as JsonSchema;

  const advertisedProps = { ...(advertised.properties as JsonSchema) };
  const derivedProps = { ...(derived.properties as JsonSchema) };

  for (const field of Object.keys(c.passthrough ?? {})) {
    expect(advertisedProps[field]).toBeDefined();
    expect(derivedProps[field]).toBeUndefined();
    delete advertisedProps[field];
  }

  for (const [field, prop] of Object.entries(derivedProps)) {
    derivedProps[field] = canonicalize(
      prop as JsonSchema,
      c.nullableAtRuntime?.includes(field) ?? false,
    );
  }

  expect(Object.keys(derivedProps).sort()).toEqual(
    Object.keys(advertisedProps).sort(),
  );
  expect(derivedProps).toEqual(advertisedProps);
  expect(
    [...((derived.required as string[] | undefined) ?? [])].sort(),
  ).toEqual([...((advertised.required as string[] | undefined) ?? [])].sort());
}
