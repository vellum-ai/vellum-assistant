/**
 * Normalized interchange type for memory-import candidates produced by the
 * assistant-migration parsers. Every parser emits a `MemoryImportItem[]`
 * JSON array on stdout so downstream review/ingest steps can consume a
 * single shape regardless of source assistant.
 */

export interface MemoryImportItem {
  /** The candidate memory text, verbatim from the source. */
  text: string;
  /**
   * Provenance tag matching the concept-page frontmatter convention:
   * `import:<provider>` (e.g. `import:chatgpt`, `import:hermes`). Imported
   * pages carry this value in their `source:` frontmatter field.
   */
  source: string;
  /** ISO 8601 timestamp of when the source recorded this item, if known. */
  origin_date?: string;
  /** Where in the source the item came from (e.g. `table.column`, `file:key`). */
  context?: string;
}

/** Print items as a JSON array on stdout (the stable parser output contract). */
export function printItemsJson(items: MemoryImportItem[]): void {
  process.stdout.write(JSON.stringify(items, null, 2) + "\n");
}

/**
 * Incremental writer for the same JSON array contract as `printItemsJson`,
 * for parsers whose candidate sets are too large to hold in memory. Items
 * are serialized one at a time (constant-size buffer per item), so neither
 * the full array nor a full serialized string ever exists. The emitted
 * bytes match `printItemsJson` exactly: a 2-space-indented JSON array plus
 * a trailing newline, parseable as `MemoryImportItem[]`.
 *
 * Call `writeItem` per candidate, then `end` exactly once to close the
 * array.
 */
export function createItemsJsonStreamWriter(write: (chunk: string) => void): {
  writeItem: (item: MemoryImportItem) => void;
  end: () => void;
} {
  let count = 0;
  return {
    writeItem(item: MemoryImportItem): void {
      const body = JSON.stringify(item, null, 2)
        .split("\n")
        .map((line) => `  ${line}`)
        .join("\n");
      write(count === 0 ? `[\n${body}` : `,\n${body}`);
      count++;
    },
    end(): void {
      write(count === 0 ? "[]\n" : "\n]\n");
    },
  };
}

const EPOCH_SECONDS_MIN = 1e9; // 2001-09-09
const EPOCH_SECONDS_MAX = 1e11;
const EPOCH_MILLIS_MIN = 1e12; // 2001-09-09 in ms
const EPOCH_MILLIS_MAX = 1e14;

/**
 * Best-effort conversion of an epoch- or ISO-looking value to an ISO 8601
 * string. Returns undefined when the value does not look like a timestamp.
 */
export function toIsoDate(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value >= EPOCH_SECONDS_MIN && value < EPOCH_SECONDS_MAX) {
      return new Date(Math.round(value * 1000)).toISOString();
    }
    if (value >= EPOCH_MILLIS_MIN && value < EPOCH_MILLIS_MAX) {
      return new Date(Math.round(value)).toISOString();
    }
    return undefined;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^\d{10}(\.\d+)?$/.test(trimmed)) {
      return toIsoDate(Number(trimmed));
    }
    if (/^\d{13}$/.test(trimmed)) {
      return toIsoDate(Number(trimmed));
    }
    if (/^\d{4}-\d{2}-\d{2}([T ].*)?$/.test(trimmed)) {
      const parsed = new Date(trimmed);
      if (!Number.isNaN(parsed.getTime())) {
        return parsed.toISOString();
      }
    }
  }
  return undefined;
}
