/**
 * How a tool call's parameters are laid out in a detail panel, decided from
 * their values alone so the component only has to draw it.
 *
 * Every parameter is a field: a label above its value. A short value is text,
 * and long or multi-line text is a code block. A list of a few short values
 * reads as one line, as does an object of a few short fields; anything larger
 * nests as fields of its own, each list item labelled by its position, down to
 * a depth past which the rest is shown as JSON.
 */

import { ACTIVITY_KEY } from "@/domains/chat/utils/tool-input";

/** Nesting depth at which a list or object is shown as JSON instead. */
const MAX_DEPTH = 4;

/** Text longer than this, or with a line break, is a code block. */
const LONG_TEXT_CHARS = 80;

/** A list or object is written on one line only when it fits in this many characters. */
const ONE_LINE_CHARS = 80;

/** Each item of a one-line list is at most this long. */
const LIST_ITEM_CHARS = 32;

/** An object is written on one line only when it has at most this many fields. */
const ONE_LINE_FIELDS = 4;

/**
 * Children of one list or object laid out before the rest are counted instead,
 * so a large collection cannot run the panel on. The raw input has them all.
 */
const MAX_CHILDREN = 20;

/** One key and short value of an object written on a single line. */
export interface ToolParamPair {
  key: string;
  text: string;
}

/** A labelled field, with its value shaped by how it is shown. */
export type ToolParamField =
  | { kind: "text"; label: string; text: string }
  | { kind: "code"; label: string; text: string }
  | { kind: "list"; label: string; items: string[] }
  | { kind: "pairs"; label: string; pairs: ToolParamPair[] }
  | { kind: "nested"; label: string; fields: ToolParamFieldList };

/** Fields in order, and how many more were left out past the cap. */
export interface ToolParamFieldList {
  fields: ToolParamField[];
  more: number;
}

function isShortText(text: string, max: number): boolean {
  return text.length <= max && !text.includes("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * The text of a value written as-is: a string, number, boolean or null, or an
 * empty list or object. `null` for anything with contents to lay out. An empty
 * or whitespace-only string is written quoted, since a blank value reads as a
 * missing one.
 */
function scalarText(value: unknown): string | null {
  if (typeof value === "string") {
    return value.trim() === "" ? JSON.stringify(value) : value;
  }
  if (Array.isArray(value)) {
    return value.length === 0 ? "[]" : null;
  }
  if (isRecord(value)) {
    return Object.keys(value).length === 0 ? "{}" : null;
  }
  return String(value);
}

/**
 * Pretty-printed JSON, for a value past the depth limit and for the raw input.
 * A value that can't be serialised (a cycle) degrades to its `String()` form
 * rather than throwing.
 */
export function jsonText(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function oneLineList(items: unknown[]): string[] | null {
  if (items.length > MAX_CHILDREN) {
    return null;
  }
  const texts: string[] = [];
  for (const item of items) {
    const text = scalarText(item);
    if (text === null || !isShortText(text, LIST_ITEM_CHARS)) {
      return null;
    }
    texts.push(text);
  }
  const length = texts.reduce((sum, text) => sum + text.length + 2, 0);
  return length <= ONE_LINE_CHARS ? texts : null;
}

function oneLinePairs(entries: [string, unknown][]): ToolParamPair[] | null {
  if (entries.length > ONE_LINE_FIELDS) {
    return null;
  }
  const pairs: ToolParamPair[] = [];
  for (const [key, value] of entries) {
    const text = scalarText(value);
    if (text === null || !isShortText(text, LIST_ITEM_CHARS)) {
      return null;
    }
    pairs.push({ key, text });
  }
  const length = pairs.reduce(
    (sum, pair) => sum + pair.key.length + pair.text.length + 3,
    0,
  );
  return length <= ONE_LINE_CHARS ? pairs : null;
}

function capped<T>(
  children: T[],
  toField: (child: T, index: number) => ToolParamField,
): ToolParamFieldList {
  return {
    fields: children.slice(0, MAX_CHILDREN).map(toField),
    more: Math.max(0, children.length - MAX_CHILDREN),
  };
}

function fieldFor(
  label: string,
  value: unknown,
  depth: number,
): ToolParamField {
  const scalar = scalarText(value);
  if (scalar !== null) {
    return typeof value === "string" && !isShortText(scalar, LONG_TEXT_CHARS)
      ? { kind: "code", label, text: scalar }
      : { kind: "text", label, text: scalar };
  }
  if (depth >= MAX_DEPTH) {
    return { kind: "code", label, text: jsonText(value) };
  }
  if (Array.isArray(value)) {
    const items = oneLineList(value);
    if (items) {
      return { kind: "list", label, items };
    }
    return {
      kind: "nested",
      label,
      fields: capped(value, (item, index) =>
        fieldFor(String(index + 1), item, depth + 1),
      ),
    };
  }
  if (isRecord(value)) {
    const entries = Object.entries(value);
    const pairs = oneLinePairs(entries);
    if (pairs) {
      return { kind: "pairs", label, pairs };
    }
    return {
      kind: "nested",
      label,
      fields: capped(entries, ([key, entryValue]) =>
        fieldFor(key, entryValue, depth + 1),
      ),
    };
  }
  return { kind: "text", label, text: String(value) };
}

/** The fields that lay out `params`, in insertion order. */
export function layoutToolParams(
  params: Record<string, unknown>,
): ToolParamFieldList {
  return capped(Object.entries(params), ([key, value]) =>
    fieldFor(key, value, 0),
  );
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
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).filter(([key]) => key !== ACTIVITY_KEY),
  );
}
