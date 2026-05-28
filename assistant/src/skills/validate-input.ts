/**
 * Pure JSON-schema input validator for skill tool calls.
 *
 * Deliberate strict subset of JSON Schema: it covers only the keywords
 * actually used by `assistant/src/config/bundled-skills/**\/TOOLS.json`
 * (required / type / enum / items.type) plus unknown-key detection. Anything
 * else (`$ref`, `oneOf`, `anyOf`, `allOf`, `format`, `pattern`, `minimum`,
 * `maximum`, object-shape `additionalProperties`, etc.) is silently skipped so
 * a richer schema can never cause us to reject a legitimate call.
 *
 * Each error message is written to be agent-readable and self-correcting
 * (e.g. `surface_id is required`, `mode must be one of "replace", "append"`).
 */

import { isPlainObject } from "../util/object.js";

export interface InputValidationSuccess {
  ok: true;
}

export interface InputValidationFailure {
  ok: false;
  /** Human-readable messages, one per problem. */
  errors: string[];
}

export type InputValidationResult =
  | InputValidationSuccess
  | InputValidationFailure;

type SupportedType =
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "array"
  | "object";

const SUPPORTED_TYPES: ReadonlySet<string> = new Set([
  "string",
  "number",
  "integer",
  "boolean",
  "array",
  "object",
]);

function matchesType(value: unknown, type: SupportedType): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return isPlainObject(value);
  }
}

function quoteList(values: readonly string[]): string {
  return values.map((v) => `"${v}"`).join(", ");
}

/**
 * Validate a tool input object against the (optional) JSON-schema definition
 * declared on the tool entry. Returns `{ ok: true }` if the input is valid (or
 * if there is nothing actionable to validate); otherwise returns a list of
 * human-readable error strings.
 *
 * Pure: never mutates `input` or `schema`, no I/O.
 */
export function validateInputAgainstSchema(
  _toolName: string,
  input: Record<string, unknown>,
  schema: Record<string, unknown> | undefined,
): InputValidationResult {
  // Skip when there's no schema or no properties block — matches today's
  // lenient behaviour for tools that declare only `{ type: "object" }`.
  if (!schema) return { ok: true };
  const properties = schema.properties;
  if (!isPlainObject(properties)) return { ok: true };

  const errors: string[] = [];
  const knownKeys = Object.keys(properties);
  const knownKeySet = new Set(knownKeys);

  // 1. Required fields — presence-only check per JSON Schema spec.
  // `required` only requires the property to be present; `null` is a valid
  // value when the schema allows it (e.g. `type: ["string", "null"]`).
  const required = schema.required;
  if (Array.isArray(required)) {
    for (const key of required) {
      if (typeof key !== "string") continue;
      if (!(key in input)) {
        errors.push(`${key} is required`);
      }
    }
  }

  // 2. Per-property checks: type, enum, items.type.
  for (const [key, rawSubSchema] of Object.entries(properties)) {
    if (!(key in input)) continue;
    const value = input[key];
    // `undefined` / `null` are treated as absent for type-checking purposes
    // so we never reject a schema that legitimately permits null (e.g. a
    // plugin schema with `type: ["string","null"]`). Combined with the
    // presence-only `required` check above, this preserves nullable inputs.
    if (value === undefined || value === null) continue;
    if (!isPlainObject(rawSubSchema)) continue;

    const declaredType = rawSubSchema.type;
    // Skip union types (e.g. `["string", "null"]`) — same lenient treatment
    // we give `oneOf`/`anyOf`/`$ref`. We only validate single-type schemas.
    if (Array.isArray(declaredType)) continue;
    if (typeof declaredType === "string" && SUPPORTED_TYPES.has(declaredType)) {
      const type = declaredType as SupportedType;
      if (!matchesType(value, type)) {
        errors.push(`${key} must be ${typeArticle(type)} ${type}`);
        // No point checking enum/items if the base type is wrong.
        continue;
      }

      // 2a. Enum (string enums are the only shape used today).
      const enumValues = rawSubSchema.enum;
      if (Array.isArray(enumValues) && enumValues.length > 0) {
        if (!enumValues.includes(value)) {
          errors.push(
            `${key} must be one of ${quoteList(enumValues.map(String))}`,
          );
        }
      }

      // 2b. Array items.type — per-element check.
      if (type === "array" && isPlainObject(rawSubSchema.items)) {
        const itemType = rawSubSchema.items.type;
        if (
          typeof itemType === "string" &&
          SUPPORTED_TYPES.has(itemType) &&
          Array.isArray(value)
        ) {
          const itemTypeName = itemType as SupportedType;
          value.forEach((element, index) => {
            if (!matchesType(element, itemTypeName)) {
              errors.push(
                `${key}[${index}] must be ${typeArticle(itemTypeName)} ${itemTypeName}`,
              );
            }
          });
        }
      }
    }
  }

  // 3. Unknown keys — parity with the previous `validateNoUnknownParams`.
  const unknownKeys = Object.keys(input).filter((k) => !knownKeySet.has(k));
  for (const key of unknownKeys) {
    errors.push(
      `Unknown parameter "${key}". Supported: ${quoteList(knownKeys)}`,
    );
  }

  if (errors.length === 0) return { ok: true };
  return { ok: false, errors };
}

function typeArticle(type: SupportedType): "a" | "an" {
  // `integer`, `array`, `object` start with a vowel sound.
  return type === "integer" || type === "array" || type === "object"
    ? "an"
    : "a";
}
