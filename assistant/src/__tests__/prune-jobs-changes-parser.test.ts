/**
 * Unit coverage for the `parseDeletedCount` helper that reads the row
 * count out of the sqlite3 CLI's stdout after a prune DELETE.
 *
 * The shape of the stdout we expect:
 *
 *   "<n>\n"
 *
 * — where `<n>` is the `SELECT changes()` value the CLI prints in
 * default output mode after the DELETE statement runs. The helper has
 * to tolerate empty/missing stdout, blank trailing lines, and any
 * incidental log line emitted above the count.
 */

import { describe, expect, test } from "bun:test";

import { _parseDeletedCount as parseDeletedCount } from "../persistence/job-handlers/cleanup.js";

describe("parseDeletedCount", () => {
  test("bare integer on its own line", () => {
    expect(parseDeletedCount("100\n")).toBe(100);
  });

  test("integer with trailing whitespace/blank lines", () => {
    expect(parseDeletedCount("100\n\n")).toBe(100);
    expect(parseDeletedCount("  42  \n")).toBe(42);
  });

  test("zero is a valid count", () => {
    expect(parseDeletedCount("0\n")).toBe(0);
  });

  test("PRUNE_LOG_BATCH_LIMIT value", () => {
    expect(parseDeletedCount("1000\n")).toBe(1000);
  });

  test("undefined stdout (subprocess never wrote anything)", () => {
    expect(parseDeletedCount(undefined)).toBe(0);
  });

  test("empty stdout", () => {
    expect(parseDeletedCount("")).toBe(0);
  });

  test("only whitespace", () => {
    expect(parseDeletedCount("   \n\n  ")).toBe(0);
  });

  test("non-numeric lines are skipped, last numeric line wins", () => {
    // Sample shape if the CLI ever logged an incidental warning above the count
    expect(parseDeletedCount("warning: foo\n250\n")).toBe(250);
  });

  test("negative values are not accepted (sqlite changes() is unsigned)", () => {
    expect(parseDeletedCount("-1\n")).toBe(0);
  });

  test("CRLF line endings", () => {
    expect(parseDeletedCount("750\r\n")).toBe(750);
  });
});
