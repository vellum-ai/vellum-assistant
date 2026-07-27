import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import type { z } from "zod";

import { scheduleCreateInputSchema } from "../schedule/create.js";
import { scheduleDeleteInputSchema } from "../schedule/delete.js";
import { scheduleListInputSchema } from "../schedule/list.js";
import { scheduleUpdateInputSchema } from "../schedule/update.js";
import { toToolInputSchema } from "../shared/zod-tool-schema.js";

/**
 * Drift guard between the schedule skill's hand-written `TOOLS.json`
 * `input_schema`s (the advertised contract) and the executors' runtime Zod
 * schemas. Skill-owned tools are skipped by the central `TOOL_INPUT_SCHEMAS`
 * gate, so the two halves live in different files — this test pins their
 * STRUCTURE (property names, types, enums, required lists) together so a
 * field added or retyped on one side cannot silently diverge on the other.
 *
 * What is deliberately NOT compared:
 *
 * - `description` strings — advertised prose is TOOLS.json-owned; the
 *   runtime schema never reads it.
 * - PASSTHROUGH fields — advertised in TOOLS.json but undeclared in the Zod
 *   schema (loose passthrough), because the executor's bespoke handling is
 *   the validation contract. Each entry documents why. The guard still
 *   asserts they exist in TOOLS.json, so a rename breaks this test.
 * - NULLABLE_AT_RUNTIME fields — declared `.nullable()` in the Zod schema
 *   though advertised non-null, because `updateSchedule` treats null as
 *   "clear this field". The guard compares them with the
 *   null branch stripped.
 */

type JsonSchema = Record<string, unknown>;

const TOOLS_JSON = JSON.parse(
  readFileSync(
    join(import.meta.dir, "../../config/bundled-skills/schedule/TOOLS.json"),
    "utf8",
  ),
) as { tools: { name: string; input_schema: JsonSchema }[] };

const CASES: {
  name: string;
  schema: z.ZodType;
  advertiseRequired?: string[];
  /** Advertised fields the runtime schema passes through unvalidated. */
  passthrough?: Record<string, string>;
  /** Declared fields that additionally accept null at runtime. */
  nullableAtRuntime?: string[];
}[] = [
  {
    name: "schedule_create",
    schema: scheduleCreateInputSchema,
    advertiseRequired: ["name", "description"],
    passthrough: {
      mode: "bespoke VALID_MODES check owns the error semantics",
      routing_intent: "bespoke VALID_ROUTING_INTENTS check owns the error",
      capabilities:
        "CapabilityManifestSchema is the single validation authority; must reach the executor (and the requireFreshApproval promotion) unaltered",
      workflow_args: "workflow runtime accepts any JSON value as args",
    },
  },
  {
    name: "schedule_update",
    schema: scheduleUpdateInputSchema,
    advertiseRequired: ["job_id"],
    passthrough: {
      mode: "bespoke VALID_MODES check owns the error semantics",
      routing_intent: "bespoke VALID_ROUTING_INTENTS check owns the error",
      then_execute:
        "resolveScheduleBindingUpdate's `=== true` coercion owns it",
      skill_id: "typeof-guarded null fallback + empty-string unbind semantics",
      workflow_name: "typeof-guarded null fallback (non-string clears)",
      workflow_args: "workflow runtime accepts any JSON value as args",
    },
    nullableAtRuntime: ["timezone", "script", "routing_hints"],
  },
  { name: "schedule_list", schema: scheduleListInputSchema },
  {
    name: "schedule_delete",
    schema: scheduleDeleteInputSchema,
    advertiseRequired: ["job_id"],
  },
];

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
 * - collapse `anyOf: [X, {type: "null"}]` (Zod's nullable encoding) into
 *   TOOLS.json's `type: [t, "null"]` array form;
 * - when `stripNull` is set (NULLABLE_AT_RUNTIME fields), drop the null
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
  // `z.looseObject({})` (an "any object" passthrough) emits an empty
  // `properties` block TOOLS.json's bare `{type: "object"}` doesn't carry.
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

describe("schedule TOOLS.json ↔ runtime Zod schema drift guard", () => {
  for (const c of CASES) {
    test(c.name, () => {
      const entry = TOOLS_JSON.tools.find((t) => t.name === c.name);
      expect(entry).toBeDefined();
      const advertised = structural(entry!.input_schema) as JsonSchema;
      const derived = structural(
        toToolInputSchema(c.schema, { advertiseRequired: c.advertiseRequired }),
      ) as JsonSchema;

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
      ).toEqual(
        [...((advertised.required as string[] | undefined) ?? [])].sort(),
      );
    });
  }
});
