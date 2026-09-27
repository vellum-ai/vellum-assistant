/**
 * Sheet fixtures for the workbook preview, which is presentational: a sheet is
 * stated as the grid it reads to, so neither a test nor a story needs to build
 * a binary workbook to drive the switcher.
 */

import type {
  SheetGrid,
  WorkbookSheet,
} from "@/domains/chat/components/local-file/preview/xlsx";

/**
 * An already-parsed grid, header row optional. It states no extent, which is
 * a sheet whose file names no used range; a fixture covering a cut spreads
 * its own over this one.
 */
export function grid(
  rows: string[][],
  headers: string[] | null = null,
): SheetGrid {
  return { headers, rows, truncated: false, extent: null };
}

/** A sheet whose grid is already in hand, the way a read one arrives. */
export function sheet(name: string, parsed: SheetGrid): WorkbookSheet {
  return { name, read: () => Promise.resolve(parsed) };
}
