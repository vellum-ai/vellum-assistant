import { describe, expect, test } from "bun:test";

import {
  type ApiRelease,
  groupApiReleasesByMonth,
  hasRealNotes,
} from "./releases-server";

function makeRelease(overrides: Partial<ApiRelease> = {}): ApiRelease {
  return {
    version: "0.10.0",
    released_at: "2026-07-01T12:00:00Z",
    is_stable: true,
    description: "Fixed a bug",
    url: null,
    ...overrides,
  };
}

describe("hasRealNotes", () => {
  test("returns false for a null description", () => {
    expect(hasRealNotes(makeRelease({ description: null }))).toBe(false);
  });

  test("returns false for an empty description", () => {
    expect(hasRealNotes(makeRelease({ description: "" }))).toBe(false);
  });

  test("returns false for whitespace-only descriptions", () => {
    expect(hasRealNotes(makeRelease({ description: "  \n\n  " }))).toBe(false);
  });

  test("returns false when only build metadata lines are present", () => {
    const description = [
      "**Build:** `0.8.10`",
      "**Commit:** `abc123`",
      "**Built at:** 2026-07-01T12:00:00Z",
    ].join("\n");
    expect(hasRealNotes(makeRelease({ description }))).toBe(false);
  });

  test("strips metadata lines with markdown list prefixes", () => {
    const description = [
      "- **Build:** `0.8.10`",
      "* **Commit:** `abc123`",
      "> **Built at:** 2026-07-01",
    ].join("\n");
    expect(hasRealNotes(makeRelease({ description }))).toBe(false);
  });

  test("returns true when real notes accompany build metadata", () => {
    const description = [
      "### Highlights",
      "- Fixed the thing",
      "**Build:** `0.8.10`",
      "**Commit:** `abc123`",
    ].join("\n");
    expect(hasRealNotes(makeRelease({ description }))).toBe(true);
  });

  test("returns true for plain human-written notes", () => {
    expect(
      hasRealNotes(makeRelease({ description: "Adds dark mode support." })),
    ).toBe(true);
  });

  test("keeps notes that begin with a metadata word but lack the colon", () => {
    expect(
      hasRealNotes(makeRelease({ description: "Build performance improved." })),
    ).toBe(true);
    expect(
      hasRealNotes(makeRelease({ description: "Commit signing is enforced." })),
    ).toBe(true);
  });

  test("keeps colon-prefixed human notes without backticked values", () => {
    expect(
      hasRealNotes(
        makeRelease({ description: "**Build:** Improved startup performance" }),
      ),
    ).toBe(true);
    expect(
      hasRealNotes(makeRelease({ description: "Commit: enforce signing" })),
    ).toBe(true);
  });
});

describe("groupApiReleasesByMonth", () => {
  test("groups releases by UTC month preserving order", () => {
    const releases = [
      makeRelease({ version: "0.10.2", released_at: "2026-07-20T00:00:00Z" }),
      makeRelease({ version: "0.10.1", released_at: "2026-07-05T00:00:00Z" }),
      makeRelease({ version: "0.10.0", released_at: "2026-06-28T00:00:00Z" }),
    ];
    const groups = groupApiReleasesByMonth(releases);
    expect(groups.map((g) => g.month)).toEqual(["July 2026", "June 2026"]);
    expect(groups[0]?.releases.map((r) => r.version)).toEqual([
      "0.10.2",
      "0.10.1",
    ]);
    expect(groups[1]?.releases.map((r) => r.version)).toEqual(["0.10.0"]);
  });

  test("returns an empty list for no releases", () => {
    expect(groupApiReleasesByMonth([])).toEqual([]);
  });
});
