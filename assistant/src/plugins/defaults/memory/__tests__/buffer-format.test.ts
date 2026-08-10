/**
 * Tests for the single owner of the `memory/buffer.md` entry format.
 *
 * These cases pin exactly which lines count as an entry opening, covering the
 * shapes a second matcher is most likely to get wrong: indentation, spacing
 * after the bullet dash, and spacing inside the date. Every one of them is the
 * difference between one fact and two.
 */

import { describe, expect, test } from "bun:test";

import {
  formatBufferTimestamp,
  formatRememberEntry,
  isBufferEntryStart,
  matchBufferEntryStart,
  splitBufferEntries,
} from "../buffer-format.js";

describe("matchBufferEntryStart", () => {
  test("matches what formatRememberEntry writes, and captures both halves", () => {
    const line = formatRememberEntry(
      "Alice prefers dark mode",
      new Date(2026, 0, 1, 9, 0),
    ).trimEnd();
    expect(line).toBe("- [Jan 1, 9:00 AM] Alice prefers dark mode");

    const match = matchBufferEntryStart(line);
    expect(match).toEqual({
      timestamp: "Jan 1, 9:00 AM",
      text: "Alice prefers dark mode",
    });
  });

  test("round-trips every hour so the AM/PM and 12-hour edges hold", () => {
    for (let hour = 0; hour < 24; hour++) {
      const line = formatRememberEntry(
        "fact",
        new Date(2026, 0, 1, hour, 5),
      ).trimEnd();
      const match = matchBufferEntryStart(line);
      expect(match).not.toBeNull();
      expect(match!.timestamp).toBe(
        formatBufferTimestamp(new Date(2026, 0, 1, hour, 5)),
      );
      expect(match!.text).toBe("fact");
    }
  });

  test("an indented entry-shaped line is body text, not a new entry", () => {
    // The writer always emits at column 0, so anything indented can only be
    // part of the fact above it. Reading it as an entry splits one multiline
    // fact into two nodes in the web Memory tab.
    expect(isBufferEntryStart("  - [Jan 1, 9:00 AM] indented")).toBe(false);
    expect(isBufferEntryStart("\t- [Jan 1, 9:00 AM] tab-indented")).toBe(false);
  });

  test("only the writer's exact spacing counts as an entry", () => {
    // A line the writer could not have produced is body text. Recognizing it
    // would either split the fact holding it or hand a caller a timestamp in a
    // shape that no real entry uses, which matters because the consolidation
    // cutoff is compared against entry timestamps textually.
    expect(isBufferEntryStart("-[Jan 1, 9:00 AM] no space after dash")).toBe(
      false,
    );
    expect(isBufferEntryStart("-  [Jan 1, 9:00 AM] two spaces")).toBe(false);
    expect(isBufferEntryStart("- [Jan  1, 9:00 AM] double-spaced date")).toBe(
      false,
    );
    expect(
      isBufferEntryStart("- [Jan 1, 9:00AM] no space before meridiem"),
    ).toBe(false);
  });

  test("day and month widths the writer produces all match", () => {
    // `formatBufferTimestamp` pads neither the day nor the hour, so single and
    // double digit forms both occur on disk.
    for (const line of [
      "- [Jan 1, 9:00 AM] single-digit day and hour",
      "- [Dec 31, 12:05 PM] double-digit day and hour",
      "- [Sep 9, 11:59 PM] boundary",
    ]) {
      expect(isBufferEntryStart(line)).toBe(true);
    }
  });

  test("continuation bullets carrying other bracketed text are not entries", () => {
    expect(isBufferEntryStart("  - [ ] a checklist item")).toBe(false);
    expect(isBufferEntryStart("- [ ] a checklist item")).toBe(false);
    expect(isBufferEntryStart("- [[wikilink]] bullet")).toBe(false);
    expect(isBufferEntryStart("  plain prose")).toBe(false);
    expect(isBufferEntryStart("")).toBe(false);
  });

  test("tolerates trailing whitespace, which editors add invisibly", () => {
    expect(isBufferEntryStart("- [Jan 1, 9:00 AM] fact   ")).toBe(true);
  });
});

describe("splitBufferEntries", () => {
  test("keeps a multiline fact's body with its opening line", () => {
    const groups = splitBufferEntries([
      "- [Jan 1, 9:00 AM] first",
      "- [Jan 2, 9:00 AM] second",
      "  body of second",
      "  - [ ] checklist inside second",
      "  - [Jan 3, 9:00 AM] indented, still second",
    ]);

    expect(groups).toHaveLength(2);
    expect(groups[0]!.lines).toEqual(["- [Jan 1, 9:00 AM] first"]);
    expect(groups[1]!.lines).toHaveLength(4);
    expect(groups[1]!.start?.text).toBe("second");
    expect(groups[1]!.firstLine).toBe(1);
  });

  test("surfaces leading prose as a headless group rather than dropping it", () => {
    const groups = splitBufferEntries([
      "hand-written header",
      "- [Jan 1, 9:00 AM] first",
    ]);

    expect(groups).toHaveLength(2);
    expect(groups[0]!.start).toBeNull();
    expect(groups[0]!.lines).toEqual(["hand-written header"]);
    expect(groups[1]!.start).not.toBeNull();
  });

  test("a buffer with no entries at all is one headless group", () => {
    const groups = splitBufferEntries(["just prose", "more prose"]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.start).toBeNull();
    expect(groups[0]!.lines).toHaveLength(2);
  });

  test("preserves every input line exactly once, in order", () => {
    const lines = [
      "prose",
      "- [Jan 1, 9:00 AM] a",
      "  body",
      "",
      "- [Jan 2, 9:00 AM] b",
    ];
    expect(splitBufferEntries(lines).flatMap((g) => g.lines)).toEqual(lines);
  });

  test("empty input yields no groups", () => {
    expect(splitBufferEntries([])).toEqual([]);
  });
});
