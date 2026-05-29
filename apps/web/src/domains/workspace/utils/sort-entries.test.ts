/**
 * Tests for `sortEntries` — the client-side re-ordering helper that backs
 * the workspace tree's "sort by size" mode.
 *
 * `sortEntries` is a pure function (no React, no mocks), so these tests run
 * fast and don't depend on the design-library import graph the rest of
 * `workspace-tree.test.tsx` has to mock around.
 */

import { describe, expect, test } from "bun:test";

import { sortEntries } from "./sort-entries";

interface Entry {
  name?: string;
  type?: string;
  size?: number | null;
}

describe("sortEntries", () => {
  test("name mode is a passthrough — server order preserved", () => {
    const entries: Entry[] = [
      { name: "alpha", type: "directory", size: null },
      { name: "beta", type: "file", size: 100 },
      { name: "gamma", type: "file", size: 50 },
    ];
    const result = sortEntries(entries, "name");
    expect(result).toBe(entries);
  });

  test("size mode sorts descending by size with files and dirs mixed", () => {
    const entries: Entry[] = [
      { name: "small-file", type: "file", size: 100 },
      { name: "huge-dir", type: "directory", size: 5000 },
      { name: "medium-file", type: "file", size: 1000 },
    ];
    const result = sortEntries(entries, "size");
    expect(result.map((e) => e.name)).toEqual([
      "huge-dir",
      "medium-file",
      "small-file",
    ]);
  });

  test("size mode sinks null-size entries to the bottom", () => {
    const entries: Entry[] = [
      { name: "unknown-dir", type: "directory", size: null },
      { name: "known-file", type: "file", size: 200 },
      { name: "also-unknown", type: "directory", size: null },
    ];
    const result = sortEntries(entries, "size");
    expect(result.map((e) => e.name)).toEqual([
      "known-file",
      "also-unknown",
      "unknown-dir",
    ]);
  });

  test("size mode tiebreaks equal sizes by name ascending", () => {
    const entries: Entry[] = [
      { name: "zeta", type: "file", size: 100 },
      { name: "alpha", type: "file", size: 100 },
      { name: "mike", type: "file", size: 100 },
    ];
    const result = sortEntries(entries, "size");
    expect(result.map((e) => e.name)).toEqual(["alpha", "mike", "zeta"]);
  });

  test("size mode does not mutate the input array", () => {
    const entries: Entry[] = [
      { name: "a", type: "file", size: 10 },
      { name: "b", type: "file", size: 20 },
    ];
    const original = entries.slice();
    sortEntries(entries, "size");
    expect(entries).toEqual(original);
  });

  test("size mode handles empty input", () => {
    expect(sortEntries([], "size")).toEqual([]);
  });
});
