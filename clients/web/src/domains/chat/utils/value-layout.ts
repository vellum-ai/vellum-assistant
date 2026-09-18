/**
 * How a value is laid out in a detail panel, decided from its shape alone so
 * the component only has to draw it.
 *
 * Every value is a field: a label above its value. A short value is text, and
 * long or multi-line text is a code block. A list of same-shaped records is a
 * table, as is an object of `columns` and `rows`. A list of a few short values
 * reads as one line, as does an object of a few short fields; anything larger
 * nests as fields of its own, each list item labelled by its position, down to
 * a depth past which the rest is shown as JSON.
 */

import { isRecord } from "@/utils/is-record";

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

/**
 * A list of records is a table only from this many records: a single record
 * reads better as its own fields than as a table of one row.
 */
const MIN_TABLE_ROWS = 2;

/** A table has at most this many columns; wider records nest as fields. */
const MAX_TABLE_COLUMNS = 12;

/**
 * Every column of a record table is present in at least this share of its
 * records. Deliberately not strict key equality: real query results omit null
 * columns per row, and a record missing a key renders an empty cell.
 */
const TABLE_KEY_COVERAGE = 0.5;

/**
 * Rows of one table laid out before the rest are counted instead. Separate
 * from `MAX_CHILDREN`, which budgets nested field blocks: each of those costs
 * a box, where a table row costs one line. The raw input has them all.
 */
const MAX_TABLE_ROWS = 100;

/** One key and short value of an object written on a single line. */
export interface ValuePair {
  key: string;
  text: string;
}

/** A list of records or a `{ columns, rows }` object, drawn as a table. */
export interface TableField {
  kind: "table";
  label: string;
  columns: string[];
  /** One cell per column per row, already written as text. */
  rows: string[][];
  /** Rows left out past the cap. */
  more: number;
}

/** A labelled field, with its value shaped by how it is shown. */
export type ValueField =
  | { kind: "text"; label: string; text: string }
  | { kind: "code"; label: string; text: string }
  | { kind: "list"; label: string; items: string[] }
  | { kind: "pairs"; label: string; pairs: ValuePair[] }
  | TableField
  | { kind: "nested"; label: string; fields: ValueFieldList };

/** Fields in order, and how many more were left out past the cap. */
export interface ValueFieldList {
  fields: ValueField[];
  more: number;
}

/** The record shape a query tool returns its result in. */
type ColumnsRowsTable = { columns: string[]; rows: unknown[][] };

function isShortText(text: string, max: number): boolean {
  return text.length <= max && !text.includes("\n");
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
 * JSON at the given indentation. A value that can't be serialised (a cycle)
 * degrades to its `String()` form rather than throwing.
 */
function stringify(value: unknown, space: number | undefined): string {
  try {
    return JSON.stringify(value, null, space) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Pretty-printed JSON, for a value past the depth limit and for the raw input. */
export function jsonText(value: unknown): string {
  return stringify(value, 2);
}

/**
 * The text of one table cell. A scalar is written the way any other value is;
 * anything with contents is compact JSON, which wraps in the cell. A missing
 * cell is empty. An explicit `null` is written out, because in a query result
 * it is a value the row carries, where an empty cell means the row has no such
 * key.
 */
function cellText(value: unknown): string {
  if (value === undefined) {
    return "";
  }
  return scalarText(value) ?? stringify(value, undefined);
}

/** The keys of `records` in the order they are first seen. */
function unionKeys(records: Record<string, unknown>[]): string[] {
  const keys = new Set<string>();
  for (const record of records) {
    for (const key of Object.keys(record)) {
      keys.add(key);
    }
  }
  return [...keys];
}

/**
 * The columns of `items` when it is a list of same-shaped records that reads
 * as a table, else `null`: at least `MIN_TABLE_ROWS` items, every one a plain
 * object, between 1 and `MAX_TABLE_COLUMNS` keys across them, and every key
 * present in at least `TABLE_KEY_COVERAGE` of the items. The columns are the
 * union of the keys in first-seen order, so a key one record adds late still
 * gets a column.
 */
function recordTableColumns(items: unknown[]): string[] | null {
  if (items.length < MIN_TABLE_ROWS || !items.every(isRecord)) {
    return null;
  }
  const columns = unionKeys(items);
  if (columns.length < 1 || columns.length > MAX_TABLE_COLUMNS) {
    return null;
  }
  const needed = items.length * TABLE_KEY_COVERAGE;
  const covered = columns.every(
    (column) =>
      items.filter((item) => Object.hasOwn(item, column)).length >= needed,
  );
  return covered ? columns : null;
}

/**
 * Whether `value` is a record written as `{ columns, rows }`: exactly those
 * two keys, `columns` a list of 1 to `MAX_TABLE_COLUMNS` strings, and `rows` at
 * least one list, none longer than `columns`. Other tabular encodings, such as
 * column objects (`{ columns: [{ name }] }`) or rows keyed by column name, are
 * not recognised and lay out as fields.
 */
function isColumnsRowsTable(
  value: Record<string, unknown>,
): value is ColumnsRowsTable {
  const keys = Object.keys(value);
  if (keys.length !== 2 || !("columns" in value) || !("rows" in value)) {
    return false;
  }
  const { columns, rows } = value;
  return (
    Array.isArray(columns) &&
    columns.length >= 1 &&
    columns.length <= MAX_TABLE_COLUMNS &&
    columns.every((column) => typeof column === "string") &&
    Array.isArray(rows) &&
    rows.length >= 1 &&
    rows.every((row) => Array.isArray(row) && row.length <= columns.length)
  );
}

/** A table of the first `MAX_TABLE_ROWS` of `total` rows, the rest counted. */
function tableField(
  label: string,
  columns: string[],
  rows: unknown[][],
  total: number,
): TableField {
  return {
    kind: "table",
    label,
    columns,
    rows: rows.map((row) => row.map(cellText)),
    more: Math.max(0, total - MAX_TABLE_ROWS),
  };
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

function oneLinePairs(entries: [string, unknown][]): ValuePair[] | null {
  if (entries.length > ONE_LINE_FIELDS) {
    return null;
  }
  const pairs: ValuePair[] = [];
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
  toField: (child: T, index: number) => ValueField,
): ValueFieldList {
  return {
    fields: children.slice(0, MAX_CHILDREN).map(toField),
    more: Math.max(0, children.length - MAX_CHILDREN),
  };
}

function fieldFor(label: string, value: unknown, depth: number): ValueField {
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
    const columns = recordTableColumns(value);
    if (columns) {
      return tableField(
        label,
        columns,
        value
          .slice(0, MAX_TABLE_ROWS)
          .map((record) => columns.map((column) => record[column])),
        value.length,
      );
    }
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
    if (isColumnsRowsTable(value)) {
      const { columns, rows } = value;
      return tableField(
        label,
        columns,
        rows
          .slice(0, MAX_TABLE_ROWS)
          .map((row) => columns.map((_, index) => row[index])),
        rows.length,
      );
    }
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

/** The fields that lay out `values`, in insertion order. */
export function layoutValues(values: Record<string, unknown>): ValueFieldList {
  return capped(Object.entries(values), ([key, value]) =>
    fieldFor(key, value, 0),
  );
}
