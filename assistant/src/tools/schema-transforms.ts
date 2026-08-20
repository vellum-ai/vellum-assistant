import type { ToolDefinition } from "../providers/types.js";

/**
 * Tools that should never have an `activity` field injected into their schema.
 * Now empty — all tools define their own `activity` property or get it injected.
 */
export const ACTIVITY_SKIP_SET = new Set<string>();

/** The status field injected into every advertised tool input schema. */
export const ACTIVITY_FIELD = "activity";

const ACTIVITY_PROPERTY = {
  type: "string",
  description:
    "Brief, natural description of what you're doing, shown as a live status update (e.g. 'Checking your project settings')",
};

/**
 * Add the injected `activity` property to a schema, so a validator checking a
 * call against the tool's own schema accepts the field the advertised schema
 * asked the model to send.
 *
 * `injectActivityField` rewrites the definitions the model sees, not the
 * manifest a skill tool validates against, so without this the model is
 * offered a field its own tool then rejects as unknown. The property is added
 * but never the `required` entry: the advertised copy asks for it, and a call
 * that leaves it out is still a call the tool can serve.
 */
export function withActivityProperty(
  schema: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!schema || schema.type !== "object") {
    return schema;
  }
  const properties = schema.properties;
  if (typeof properties !== "object" || properties === null) {
    return schema;
  }
  if (schemaDefinesProperty(schema, ACTIVITY_FIELD)) {
    return schema;
  }
  return {
    ...schema,
    properties: { ...properties, [ACTIVITY_FIELD]: ACTIVITY_PROPERTY },
  };
}

/**
 * Injects an `activity` string property into each tool definition's input
 * schema, unless the tool is in the skip set, already has an activity field,
 * or has a non-object schema.
 *
 * CRITICAL: Never mutates the input definitions - always returns deep clones
 * for any modified definition, since `Tool.input_schema` is a shared ref.
 */
export function injectActivityField(
  definitions: ToolDefinition[],
  skip: Set<string> = ACTIVITY_SKIP_SET,
): ToolDefinition[] {
  return definitions.map((def) => {
    if (skip.has(def.name)) {
      return def;
    }

    const schema = def.input_schema as Record<string, unknown> | undefined;
    if (
      schema == null ||
      typeof schema !== "object" ||
      schema.type !== "object" ||
      !schema.properties
    ) {
      return def;
    }

    const properties = schema.properties as Record<string, unknown>;

    if (schemaDefinesProperty(schema, "activity")) {
      // Activity is already defined somewhere in the schema (top-level properties
      // or composite sub-schemas). Don't modify schemas we don't own — MCP tools
      // may define activity as intentionally optional or with server-specific
      // semantics.
      return def;
    }

    // Deep clone to avoid mutating shared refs
    const newProperties = {
      ...properties,
      [ACTIVITY_FIELD]: ACTIVITY_PROPERTY,
    };
    const existingRequired = Array.isArray(schema.required)
      ? [...schema.required, "activity"]
      : ["activity"];

    return {
      ...def,
      input_schema: {
        ...schema,
        properties: newProperties,
        required: existingRequired,
      },
    };
  });
}

/**
 * Checks whether a JSON Schema defines a given property name.
 * Walks `allOf`, `oneOf`, `anyOf` recursively.
 *
 * `$ref` handling is configurable via `refBehavior`:
 * - `'assume-undefined'` (default): fail-closed, treat `$ref` as not defining
 *   the property. Good for injection (safe to double-inject).
 * - `'assume-defined'`: fail-open, treat `$ref` as possibly defining the
 *   property. Good for stripping decisions (don't strip what the server may need).
 */
export function schemaDefinesProperty(
  schema: unknown,
  propertyName: string,
  options?: { refBehavior?: "assume-defined" | "assume-undefined" },
): boolean {
  if (schema == null || typeof schema !== "object") {
    return false;
  }

  const s = schema as Record<string, unknown>;
  const refBehavior = options?.refBehavior ?? "assume-undefined";

  // $ref: we can't resolve it, so use the configured behavior
  if ("$ref" in s) {
    return refBehavior === "assume-defined";
  }

  // Check direct properties
  if (
    s.properties &&
    typeof s.properties === "object" &&
    propertyName in (s.properties as Record<string, unknown>)
  ) {
    return true;
  }

  // Walk composite keywords
  for (const keyword of ["allOf", "oneOf", "anyOf"] as const) {
    const arr = s[keyword];
    if (Array.isArray(arr)) {
      for (const member of arr) {
        if (schemaDefinesProperty(member, propertyName, options)) {
          return true;
        }
      }
    }
  }

  return false;
}
