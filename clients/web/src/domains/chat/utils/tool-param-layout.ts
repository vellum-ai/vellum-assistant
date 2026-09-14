/**
 * How a tool call's parameters are laid out in a detail panel, decided from
 * their values alone so the component only has to draw it.
 *
 * Every parameter is a field: a label above its value. A short value is text,
 * and long or multi-line text is a code block. A list of a few short values
 * reads as one line, as does an object of a few short fields; anything larger
 * nests as fields of its own, each list item labelled by its position.
 */

import type {
  ToolParamEntry,
  ToolParamValue,
} from "@/domains/chat/utils/tool-params";

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

/** The text of a string, number, boolean or null value, or `null` otherwise. */
function scalarText(value: ToolParamValue): string | null {
  return value.kind === "text" || value.kind === "literal" ? value.text : null;
}

function oneLineList(items: ToolParamValue[]): string[] | null {
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

function oneLinePairs(entries: ToolParamEntry[]): ToolParamPair[] | null {
  if (entries.length > ONE_LINE_FIELDS) {
    return null;
  }
  const pairs: ToolParamPair[] = [];
  for (const entry of entries) {
    const text = scalarText(entry.value);
    if (text === null || !isShortText(text, LIST_ITEM_CHARS)) {
      return null;
    }
    pairs.push({ key: entry.key, text });
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

function fieldFor(label: string, value: ToolParamValue): ToolParamField {
  switch (value.kind) {
    case "literal":
      return { kind: "text", label, text: value.text };
    case "text":
      return isShortText(value.text, LONG_TEXT_CHARS)
        ? { kind: "text", label, text: value.text }
        : { kind: "code", label, text: value.text };
    case "json":
      return { kind: "code", label, text: value.json };
    case "list": {
      const items = oneLineList(value.items);
      if (items) {
        return { kind: "list", label, items };
      }
      return {
        kind: "nested",
        label,
        fields: capped(value.items, (item, index) =>
          fieldFor(String(index + 1), item),
        ),
      };
    }
    case "object": {
      const pairs = oneLinePairs(value.entries);
      if (pairs) {
        return { kind: "pairs", label, pairs };
      }
      return {
        kind: "nested",
        label,
        fields: capped(value.entries, (entry) =>
          fieldFor(entry.key, entry.value),
        ),
      };
    }
  }
}

/** The fields that lay out `params`, in order. */
export function layoutToolParams(params: ToolParamEntry[]): ToolParamFieldList {
  return capped(params, (param) => fieldFor(param.key, param.value));
}
