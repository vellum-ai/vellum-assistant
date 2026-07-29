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
