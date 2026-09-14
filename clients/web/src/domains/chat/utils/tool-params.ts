/**
 * A tool call's input as the rows a detail panel shows: one per parameter,
 * scalars as display strings, objects and arrays as pretty-printed JSON.
 */

/** One parameter of a tool call. */
export interface ToolParam {
  key: string;
  /**
   * Display string for a scalar value (string / number / boolean / null).
   * `null` when the value is an object or array; read `json` instead.
   */
  scalar: string | null;
  /** Pretty-printed JSON for object/array values; `null` for scalars. */
  json: string | null;
}

/**
 * Format a single parameter value for display. Scalars render inline; objects
 * and arrays are pretty-printed as JSON so nested structure stays legible. A
 * value that can't be serialised (a cycle) degrades to its `String()` form
 * rather than throwing.
 */
function formatParamValue(value: unknown): Pick<ToolParam, "scalar" | "json"> {
  if (value === null) {
    return { scalar: "null", json: null };
  }
  if (typeof value === "string") {
    return { scalar: value, json: null };
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return { scalar: String(value), json: null };
  }
  if (typeof value === "undefined") {
    return { scalar: "undefined", json: null };
  }
  try {
    return {
      scalar: null,
      json: JSON.stringify(value, null, 2) ?? String(value),
    };
  } catch {
    return { scalar: String(value), json: null };
  }
}

/** The entries of `bag` as parameters, in insertion order. */
export function toToolParams(bag: Record<string, unknown>): ToolParam[] {
  return Object.entries(bag).map(([key, value]) => ({
    key,
    ...formatParamValue(value),
  }));
}

/**
 * The parameters a tool call was given, without its `activity` sentence.
 *
 * The daemon adds `activity` to every tool's input schema as a status line for
 * the user (`assistant/src/tools/schema-transforms.ts`), and the detail panel's
 * header already shows it, so a row for it would say the same thing twice. The
 * raw input still carries it.
 */
export function toolCallParams(input: Record<string, unknown>): ToolParam[] {
  return toToolParams(
    Object.fromEntries(
      Object.entries(input).filter(([key]) => key !== "activity"),
    ),
  );
}
