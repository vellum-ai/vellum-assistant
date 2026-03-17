import type { ToolDefinition } from "../providers/types.js";

/**
 * Tools that should never have an `activity` field injected into their schema.
 * Now empty — all tools define their own `activity` property or get it injected.
 */
export const ACTIVITY_SKIP_SET = new Set<string>();

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
        if (schemaDefinesProperty(member, propertyName)) {
          return true;
        }
      }
    }
  }

  return false;
}
