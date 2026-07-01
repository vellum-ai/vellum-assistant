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
 * Coerce string-encoded booleans (`"true"`/`"false"`) to real booleans for
 * properties the schema declares as `type: "boolean"`.
 *
 * Some providers' models serialize booleans as JSON strings. Rejecting those
 * loses the caller's intent: the model's typical recovery is to drop the field
 * and retry, at which point the field's default silently inverts what it asked
 * for (e.g. `app_create` with `auto_open: "false"` → retry omits the field →
 * default `true` opens a half-built app). Accepting the unambiguous string
 * forms preserves intent.
 *
 * Pure: returns a new object when a coercion applies, otherwise returns
 * `input` unchanged. Never mutates `input` or `schema`.
 */
export function coerceStringBooleans(
  input: Record<string, unknown>,
  schema: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!schema) return input;
  const properties = schema.properties;
  if (!isPlainObject(properties)) return input;

  let coerced: Record<string, unknown> | undefined;
  for (const [key, rawSubSchema] of Object.entries(properties)) {
    if (!isPlainObject(rawSubSchema)) continue;
    if (rawSubSchema.type !== "boolean") continue;
    const value = input[key];
    if (typeof value !== "string") continue;
    const normalized = value.trim().toLowerCase();
    if (normalized !== "true" && normalized !== "false") continue;
    coerced ??= { ...input };
    coerced[key] = normalized === "true";
  }
  return coerced ?? input;
}

/**
 * Coerce finite JSON numbers to strings for properties the schema declares as
 * `type: "string"`.
 *
 * Some providers' models emit numeric-looking string values as unquoted JSON
 * numbers (e.g. a phone number `61415323232` instead of `"+61415323232"`).
 * Plain `JSON.parse` yields a JS `Number`, which then fails the validator's
 * `typeof === "string"` check with a confusing "must be a string" error that
 * sends the model down a wrong retry path. The value's intent is unambiguous —
 * a string field received a number — so coerce it the same way we coerce
 * string-encoded booleans. The E.164 / format / enum checks downstream still
 * run on the coerced string, so a number missing a `+` prefix still gets a
 * self-correcting format error rather than a type error.
 *
 * Only finite numbers are coerced; `NaN`/`Infinity` (which can't come from
 * JSON.parse anyway) and non-number types are left untouched. Pure: returns a
 * new object when a coercion applies, otherwise returns `input` unchanged.
 * Never mutates `input` or `schema`.
 */
export function coerceStringNumbers(
  input: Record<string, unknown>,
  schema: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!schema) return input;
  const properties = schema.properties;
  if (!isPlainObject(properties)) return input;

  let coerced: Record<string, unknown> | undefined;
  for (const [key, rawSubSchema] of Object.entries(properties)) {
    if (!isPlainObject(rawSubSchema)) continue;
    if (rawSubSchema.type !== "string") continue;
    const value = input[key];
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    coerced ??= { ...input };
    coerced[key] = String(value);
  }
  return coerced ?? input;
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
    // Skip type-checking for absent values; presence is enforced by the
    // `required` check above. Note: `null` IS a present value and is
    // type-checked below — only schemas that explicitly opt in to null via
    // a union type (`type: ["string","null"]`) bypass the check, handled
    // by the `Array.isArray(declaredType)` skip immediately below.
    if (value === undefined) continue;
    if (!isPlainObject(rawSubSchema)) continue;

    const declaredType = rawSubSchema.type;
    // Skip union types (e.g. `["string", "null"]`) — same lenient treatment
    // we give `oneOf`/`anyOf`/`$ref`. We only validate single-type schemas.
    if (Array.isArray(declaredType)) continue;
    if (typeof declaredType === "string" && SUPPORTED_TYPES.has(declaredType)) {
      const type = declaredType as SupportedType;
      if (!matchesType(value, type)) {
        errors.push(
          type === "boolean" && typeof value === "string"
            ? `${key} must be a boolean — pass true or false as a JSON boolean, not a string`
            : `${key} must be ${typeArticle(type)} ${type}`,
        );
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
