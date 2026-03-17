import type { ToolDefinition } from "../providers/types.js";

/**
 * Tools that should never have an `activity` field injected into their schema.
 */
export const ACTIVITY_SKIP_SET = new Set<string>([
  "skill_execute",
  "bash",
  "host_bash",
  "request_system_permission",
]);

/** @deprecated Use ACTIVITY_SKIP_SET */
export const REASON_SKIP_SET = ACTIVITY_SKIP_SET;

/**
 * Injects an `activity` string property into each tool definition's input
 * schema, unless the tool is in the skip set, already has an activity field,
 * or has a non-object schema.
 *
 * CRITICAL: Never mutates the input definitions - always returns deep clones
 * for any modified definition, since `getDefinition()` returns shared refs.
 */
export function injectActivityField(
  definitions: ToolDefinition[],
  skip: Set<string> = ACTIVITY_SKIP_SET,
): ToolDefinition[] {
  return definitions.map((def) => {
    if (skip.has(def.name)) {
      return def;
    }

    const schema = def.input_schema as Record<string, unknown>;
    if (schema.type !== "object" || !schema.properties) {
      return def;
    }

    const properties = schema.properties as Record<string, unknown>;
    if (schemaDefinesProperty(schema, "activity")) {
      return def;
    }

    // Deep clone to avoid mutating shared refs
    const newProperties = {
      ...properties,
      activity: {
        type: "string",
        description:
          "Brief, natural description of what you're doing, shown as a live status update (e.g. 'Checking your project settings')",
      },
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

/** @deprecated Use injectActivityField */
export const injectReasonField = injectActivityField;

/**
 * Checks whether a JSON Schema defines a given property name.
 * Walks `allOf`, `oneOf`, `anyOf` recursively.
 * Fail-closed on `$ref`: returns false if a `$ref` is encountered.
 */
export function schemaDefinesProperty(
  schema: unknown,
  propertyName: string,
): boolean {
  if (schema == null || typeof schema !== "object") {
    return false;
  }

  const s = schema as Record<string, unknown>;

  // Fail-closed on $ref - we can't resolve it, so treat as "doesn't define it"
  if ("$ref" in s) {
    return false;
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
        if (schemaDefinesProperty(member, propertyName)) {
          return true;
        }
      }
    }
  }

  return false;
}
