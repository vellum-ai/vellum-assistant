/**
 * RFC 4180 reader for delimited text files, used by the drawer's read-only
 * spreadsheet preview.
 *
 * Hand-rolled rather than pulled from a dependency: the preview needs exactly
 * one shape (a rectangular grid, capped so a huge export cannot wedge the tab)
 * and none of the streaming, typing, or transform machinery a CSV library
 * carries. Parsing stops at the caps, so a 200 MB export costs the same as a
 * 5000-row one.
 *
 * @see https://www.rfc-editor.org/rfc/rfc4180
 */

/** Hard cap on records read, header included. */
export const MAX_CSV_ROWS = 5000;

/** Hard cap on columns kept per record. */
export const MAX_CSV_COLUMNS = 200;

/**
 * Delimiters we sniff between, in tie-break order: a file that uses the same
 * number of commas and semicolons on its first line is far more likely to be
 * comma-separated.
 */
const DELIMITERS = [",", ";", "\t"] as const;

export interface ParsedCsv {
  /** The first record when it reads as a header row, else `null`. */
  headers: string[] | null;
  /** Data records, padded to a common width. Excludes the header row. */
  rows: string[][];
  /** True when a cap cut the file short, so the view can say so. */
  truncated: boolean;
}

/** A cell that is nothing but a number, in any of the usual spellings. */
function isNumericCell(cell: string): boolean {
  const trimmed = cell.trim();
  if (trimmed === "") {
    return false;
  }
  return /^[+-]?(\d+(\.\d+)?|\.\d+)([eE][+-]?\d+)?$/.test(trimmed);
}

/**
 * Count `delimiter` occurrences on the first non-empty line, ignoring any that
 * sit inside a quoted field. Quotes are tracked across the whole scan so a
 * field containing a newline does not end the line early.
 */
function countOnFirstLine(text: string, delimiter: string): number {
  let count = 0;
  let inQuotes = false;
  let sawContent = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          i += 1;
        } else {
          inQuotes = false;
        }
      }
      sawContent = true;
      continue;
    }
    if (char === '"') {
      inQuotes = true;
      sawContent = true;
      continue;
    }
    if (char === "\n" || char === "\r") {
      if (sawContent) {
        break;
      }
      continue;
    }
    if (char === delimiter) {
      count += 1;
    }
    sawContent = true;
  }
  return count;
}

/** The delimiter that splits the first non-empty line into the most fields. */
function sniffDelimiter(text: string): string {
  let best: string = DELIMITERS[0];
  let bestCount = 0;
  for (const candidate of DELIMITERS) {
    const count = countOnFirstLine(text, candidate);
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Split `text` into records on `delimiter`, honouring quoted fields (embedded
 * delimiters, newlines, and `""`-escaped quotes) and both CRLF and LF endings.
 * Stops once `MAX_CSV_ROWS` records are complete.
 */
function readRecords(
  text: string,
  delimiter: string,
): { records: string[][]; truncated: boolean } {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let inQuotes = false;
  let truncated = false;

  /** Close the current record, dropping the blank lines between records. */
  const endRecord = (): void => {
    record.push(field);
    field = "";
    const isBlankLine = record.length === 1 && record[0] === "";
    if (!isBlankLine) {
      records.push(record);
    }
    record = [];
  };

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"' && field === "") {
      inQuotes = true;
      continue;
    }
    if (char === delimiter) {
      record.push(field);
      field = "";
      continue;
    }
    if (char === "\r" || char === "\n") {
      if (char === "\r" && text[i + 1] === "\n") {
        i += 1;
      }
      endRecord();
      if (records.length >= MAX_CSV_ROWS) {
        // Anything left is past the cap. Trailing whitespace alone is not a
        // truncation, so look for real content before saying so.
        truncated = text.slice(i + 1).trim() !== "";
        return { records, truncated };
      }
      continue;
    }
    field += char;
  }

  // A file that does not end in a newline still has one last record.
  if (field !== "" || record.length > 0) {
    endRecord();
  }
  return { records, truncated };
}

/**
 * Whether the first record reads as a header rather than data.
 *
 * Deliberately conservative and cheap: a header row has a label in every
 * column and no bare numbers, while the data below it has at least one number.
 * Files that are entirely text therefore render without a header, which shows
 * every row rather than silently hiding one.
 */
function looksLikeHeader(records: string[][]): boolean {
  const first = records[0];
  if (!first || records.length < 2) {
    return false;
  }
  if (first.some((cell) => cell.trim() === "" || isNumericCell(cell))) {
    return false;
  }
  return records
    .slice(1)
    .some((row) => row.some((cell) => isNumericCell(cell)));
}

/**
 * Parse delimited text into a rectangular grid: quoted fields, CRLF or LF
 * endings, sniffed delimiter, ragged rows padded to a common width, and hard
 * caps on rows and columns.
 */
export function parseCsv(text: string): ParsedCsv {
  // A UTF-8 BOM is a byte-order artefact of the writer, not part of the first
  // header cell.
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (source.trim() === "") {
    return { headers: null, rows: [], truncated: false };
  }

  const { records, truncated: rowsTruncated } = readRecords(
    source,
    sniffDelimiter(source),
  );
  if (records.length === 0) {
    return { headers: null, rows: [], truncated: rowsTruncated };
  }

  const widest = records.reduce((max, row) => Math.max(max, row.length), 0);
  const width = Math.min(widest, MAX_CSV_COLUMNS);
  const columnsTruncated = widest > MAX_CSV_COLUMNS;
  const shaped = records.map((row) => {
    const cells = row.slice(0, width);
    while (cells.length < width) {
      cells.push("");
    }
    return cells;
  });

  const hasHeader = looksLikeHeader(shaped);
  return {
    headers: hasHeader ? shaped[0]! : null,
    rows: hasHeader ? shaped.slice(1) : shaped,
    truncated: rowsTruncated || columnsTruncated,
  };
}
