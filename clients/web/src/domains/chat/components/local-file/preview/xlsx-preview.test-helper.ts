/**
 * Sheet fixtures for the workbook preview, which is presentational: a sheet is
 * stated as the grid it reads to, so neither a test nor a story needs to build
 * a binary workbook to drive the switcher.
 */

import type { ParsedCsv } from "@/domains/chat/components/local-file/preview/csv";
import type { WorkbookSheet } from "@/domains/chat/components/local-file/preview/xlsx";

/** An already-parsed grid, header row optional. */
export function grid(
  rows: string[][],
  headers: string[] | null = null,
): ParsedCsv {
  return { headers, rows, truncated: false };
}

/** A sheet whose grid is already in hand, the way a read one arrives. */
export function sheet(name: string, parsed: ParsedCsv): WorkbookSheet {
  return { name, read: () => Promise.resolve(parsed) };
}
