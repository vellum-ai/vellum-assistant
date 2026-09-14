/**
 * A tool call's input as a tree a detail panel can lay out: each parameter a
 * key with a typed value, objects as entries and arrays as items, so nothing
 * but a value nested too deep to lay out has to be shown as JSON.
 */

/** Nesting depth at which an object or array is shown as JSON instead. */
const MAX_DEPTH = 4;

/**
 * A value in a tool call's input, typed by how it is shown: `text` for a
 * string, `literal` for a number, boolean, null or empty collection written
 * as-is, `list` and `object` for structure, and `json` for a subtree nested
 * past {@link MAX_DEPTH}.
 */
export type ToolParamValue =
  | { kind: "text"; text: string }
  | { kind: "literal"; text: string }
  | { kind: "list"; items: ToolParamValue[] }
  | { kind: "object"; entries: ToolParamEntry[] }
  | { kind: "json"; json: string };

/** One keyed value: a parameter, or a field of an object parameter. */
export interface ToolParamEntry {
  key: string;
  value: ToolParamValue;
}

/**
 * Pretty-printed JSON for a subtree past the depth limit. A value that can't
 * be serialised (a cycle) degrades to its `String()` form rather than throwing.
 */
function toJsonValue(value: unknown): ToolParamValue {
  try {
    return {
      kind: "json",
      json: JSON.stringify(value, null, 2) ?? String(value),
    };
  } catch {
    return { kind: "literal", text: String(value) };
  }
}

function toParamValue(value: unknown, depth: number): ToolParamValue {
  if (typeof value === "string") {
    return { kind: "text", text: value };
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return { kind: "literal", text: "[]" };
    }
    if (depth >= MAX_DEPTH) {
      return toJsonValue(value);
    }
    return {
      kind: "list",
      items: value.map((item) => toParamValue(item, depth + 1)),
    };
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length === 0) {
      return { kind: "literal", text: "{}" };
    }
    if (depth >= MAX_DEPTH) {
      return toJsonValue(value);
    }
    return {
      kind: "object",
      entries: entries.map(([key, entryValue]) => ({
        key,
        value: toParamValue(entryValue, depth + 1),
      })),
    };
  }
  return { kind: "literal", text: String(value) };
}

/** The entries of `bag` as parameters, in insertion order. */
export function toToolParams(bag: Record<string, unknown>): ToolParamEntry[] {
  return Object.entries(bag).map(([key, value]) => ({
    key,
    value: toParamValue(value, 0),
  }));
}

/**
 * The parameters a tool call was given, without its `activity` sentence.
 *
 * The daemon adds `activity` to every tool's input schema as a status line for
 * the user (`assistant/src/tools/schema-transforms.ts`), and the detail panel's
 * header already shows it, so a field for it would say the same thing twice. The
 * raw input still carries it.
 */
export function toolCallParams(
  input: Record<string, unknown>,
): ToolParamEntry[] {
  return toToolParams(
    Object.fromEntries(
      Object.entries(input).filter(([key]) => key !== "activity"),
    ),
  );
}
