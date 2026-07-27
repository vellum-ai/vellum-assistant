import { z } from "zod";

import type { ToolExecutionResult } from "../types.js";

/**
 * Derive a tool's LLM-facing `input_schema` from its Zod input schema, so the
 * schema the model sees and the validation the executor runs share one source
 * and cannot drift (`TOOL_INPUT_SCHEMAS` in `../tool-input-schemas.ts` holds
 * the executor-side half).
 *
 * Conversion uses Zod 4's native `z.toJSONSchema` (mirroring
 * `workflows/leaf-runner.ts`), then adjusts the output for the tool-definition
 * context:
 *
 * - The `$schema` marker is dropped — tool definitions don't carry one.
 * - `additionalProperties` values of `false` / `{}` are dropped. They are
 *   authoring artifacts of `z.object` / `z.looseObject`, not intentional
 *   contract: runtime validation never rejects unknown keys (registry schemas
 *   must tolerate injected fields like `activity`, see
 *   `schema-transforms.ts`), so advertising `additionalProperties: false`
 *   would claim a strictness the runtime doesn't enforce.
 *
 * `advertiseRequired` names fields to mark required in the advertised schema
 * even though the Zod schema treats them as optional. This is the one
 * sanctioned divergence, and only in the tolerant direction: the model is told
 * to always send the field (e.g. `activity`, which drives status UX), but a
 * call that omits it still executes rather than failing on a field the tool
 * doesn't need.
 */
export function toToolInputSchema(
  schema: z.ZodType,
  opts?: { advertiseRequired?: readonly string[] },
): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { unrepresentable: "any" }) as Record<
    string,
    unknown
  >;
  delete json.$schema;
  stripPermissiveAdditionalProperties(json);

  for (const field of opts?.advertiseRequired ?? []) {
    const required = Array.isArray(json.required) ? json.required : [];
    if (!required.includes(field)) {
      json.required = [...required, field];
    }
  }
  return json;
}

/**
 * Recursively remove `additionalProperties` keys whose value is `false` or the
 * empty schema `{}`. A real subschema (e.g. `additionalProperties:
 * { type: "string" }` from `z.record`) is left intact.
 */
function stripPermissiveAdditionalProperties(node: unknown): void {
  if (Array.isArray(node)) {
    for (const entry of node) {
      stripPermissiveAdditionalProperties(entry);
    }
    return;
  }
  if (node === null || typeof node !== "object") {
    return;
  }
  const record = node as Record<string, unknown>;
  const ap = record.additionalProperties;
  if (
    ap === false ||
    (typeof ap === "object" &&
      ap !== null &&
      !Array.isArray(ap) &&
      Object.keys(ap).length === 0)
  ) {
    delete record.additionalProperties;
  }
  for (const value of Object.values(record)) {
    stripPermissiveAdditionalProperties(value);
  }
}

/**
 * Wrap an optional field's schema so an explicit `null` parses as "omitted"
 * (`undefined`). Models routinely send `null` for optional fields they mean
 * to skip, and executors read such fields via `input.x ?? fallback`, where
 * null and absent are equivalent — validation must not reject null there.
 * The derived JSON Schema is the inner schema's (the null-tolerance is
 * runtime slack, not advertised contract).
 */
export function nullAsOmitted<T extends z.ZodType>(schema: T) {
  return z.preprocess((value) => value ?? undefined, schema.optional());
}

/**
 * Render a failed tool-input parse as a compact `field: message` summary the
 * model can correct from. Mirrors `runtime/routes/parse-body.ts`.
 */
export function formatToolInputError(
  toolName: string,
  error: z.ZodError,
): string {
  const detail = error.issues
    .map((issue) => `${issue.path.join(".") || "(input)"}: ${issue.message}`)
    .join("; ");
  return `Invalid input for tool "${toolName}": ${detail}. Fix the listed field(s) and retry the call.`;
}

/**
 * Failed-parse tool result for executors that validate their own input (the
 * pre-execution gate in `ToolApprovalHandler` produces the same message, so
 * the error reads identically whichever layer catches it first).
 */
export function invalidToolInputResult(
  toolName: string,
  error: z.ZodError,
): ToolExecutionResult {
  return { content: formatToolInputError(toolName, error), isError: true };
}
