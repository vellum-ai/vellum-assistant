import {
  mkdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const TEST_DIR = join(tmpdir(), `vellum-journal-test-${crypto.randomUUID()}`);

// eslint-disable-next-line @typescript-eslint/no-require-imports
const realPlatform = require("../util/platform.js");
mock.module("../util/platform.js", () => ({
  ...realPlatform,
  getWorkspaceDir: () => TEST_DIR,
}));

const { buildJournalContext, formatJournalRelativeTime } = await import(
  "../prompts/journal-context.js"
);

describe("formatJournalRelativeTime", () => {
  test("returns 'just now' for times less than 60 seconds ago", () => {
    const now = Date.now();
    expect(formatJournalRelativeTime(now - 30_000)).toBe("just now");
    expect(formatJournalRelativeTime(now - 1_000)).toBe("just now");
    expect(formatJournalRelativeTime(now)).toBe("just now");
  });

  test("returns minutes for times between 1-59 minutes ago", () => {
    const now = Date.now();
    expect(formatJournalRelativeTime(now - 60_000)).toBe("1 minute ago");
    expect(formatJournalRelativeTime(now - 5 * 60_000)).toBe("5 minutes ago");
    expect(formatJournalRelativeTime(now - 59 * 60_000)).toBe("59 minutes ago");
  });

  test("returns hours for times between 1-23 hours ago", () => {
    const now = Date.now();
    expect(formatJournalRelativeTime(now - 60 * 60_000)).toBe("1 hour ago");
    expect(formatJournalRelativeTime(now - 3 * 60 * 60_000)).toBe("3 hours ago");
    expect(formatJournalRelativeTime(now - 23 * 60 * 60_000)).toBe("23 hours ago");
  });

  test("returns days for times between 1-6 days ago", () => {
    const now = Date.now();
    expect(formatJournalRelativeTime(now - 24 * 60 * 60_000)).toBe("1 day ago");
    expect(formatJournalRelativeTime(now - 3 * 24 * 60 * 60_000)).toBe("3 days ago");
    expect(formatJournalRelativeTime(now - 6 * 24 * 60 * 60_000)).toBe("6 days ago");
  });

  test("returns weeks for times 7 or more days ago", () => {
    const now = Date.now();
    expect(formatJournalRelativeTime(now - 7 * 24 * 60 * 60_000)).toBe("1 week ago");
    expect(formatJournalRelativeTime(now - 14 * 24 * 60 * 60_000)).toBe(
      "2 weeks ago",
    );
    expect(formatJournalRelativeTime(now - 30 * 24 * 60 * 60_000)).toBe(
      "4 weeks ago",
    );
  });
});

describe("buildJournalContext", () => {
  const journalDir = join(TEST_DIR, "journal");

  beforeEach(() => {
    mkdirSync(journalDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  test("returns null when maxEntries is 0", () => {
    writeFileSync(join(journalDir, "entry.md"), "content");
    expect(buildJournalContext(0)).toBeNull();
  });

  test("returns null when maxEntries is negative", () => {
    writeFileSync(join(journalDir, "entry.md"), "content");
    expect(buildJournalContext(-1)).toBeNull();
  });

  test("returns null when journal directory does not exist", () => {
    rmSync(journalDir, { recursive: true, force: true });
    expect(buildJournalContext(10)).toBeNull();
  });

  test("returns null when journal directory has no .md files", () => {
    writeFileSync(join(journalDir, "notes.txt"), "not markdown");
    expect(buildJournalContext(10)).toBeNull();
  });

  test("excludes README.md (case-insensitive)", () => {
    writeFileSync(join(journalDir, "README.md"), "readme content");
    writeFileSync(join(journalDir, "readme.md"), "readme content lower");
    expect(buildJournalContext(10)).toBeNull();
  });

  test("returns formatted journal context with single entry", () => {
    writeFileSync(join(journalDir, "goals.md"), "My goals for this week.");
    const result = buildJournalContext(10);
    expect(result).not.toBeNull();
    expect(result).toContain("# Journal");
    expect(result).toContain(
      "Your journal entries, most recent first. These are YOUR words from past conversations.",
    );
    expect(result).toContain("## goals.md — MOST RECENT");
    expect(result).toContain("My goals for this week.");
    // Single entry, window not full — should NOT have LEAVING CONTEXT
    expect(result).not.toContain("LEAVING CONTEXT");
  });

  test("sorts entries by mtime, newest first", () => {
    const now = new Date();

    writeFileSync(join(journalDir, "old.md"), "old entry");
    const oldTime = new Date(now.getTime() - 3 * 24 * 60 * 60_000);
    utimesSync(join(journalDir, "old.md"), oldTime, oldTime);

    writeFileSync(join(journalDir, "mid.md"), "mid entry");
    const midTime = new Date(now.getTime() - 1 * 24 * 60 * 60_000);
    utimesSync(join(journalDir, "mid.md"), midTime, midTime);

    writeFileSync(join(journalDir, "new.md"), "new entry");
    const newTime = new Date(now.getTime() - 60_000);
    utimesSync(join(journalDir, "new.md"), newTime, newTime);

    const result = buildJournalContext(10)!;
    const newIdx = result.indexOf("new.md");
    const midIdx = result.indexOf("mid.md");
    const oldIdx = result.indexOf("old.md");
    expect(newIdx).toBeLessThan(midIdx);
    expect(midIdx).toBeLessThan(oldIdx);
  });

  test("marks most recent entry with MOST RECENT", () => {
    const now = new Date();

    writeFileSync(join(journalDir, "older.md"), "older");
    const olderTime = new Date(now.getTime() - 2 * 24 * 60 * 60_000);
    utimesSync(join(journalDir, "older.md"), olderTime, olderTime);

    writeFileSync(join(journalDir, "newest.md"), "newest");
    const newestTime = new Date(now.getTime() - 60_000);
    utimesSync(join(journalDir, "newest.md"), newestTime, newestTime);

    const result = buildJournalContext(10)!;
    expect(result).toContain("## newest.md — MOST RECENT");
    expect(result).not.toContain("## older.md — MOST RECENT");
  });

  test("marks oldest entry with LEAVING CONTEXT when window is full", () => {
    const now = new Date();

    writeFileSync(join(journalDir, "a.md"), "entry a");
    utimesSync(
      join(journalDir, "a.md"),
      new Date(now.getTime() - 60_000),
      new Date(now.getTime() - 60_000),
    );

    writeFileSync(join(journalDir, "b.md"), "entry b");
    utimesSync(
      join(journalDir, "b.md"),
      new Date(now.getTime() - 2 * 60 * 60_000),
      new Date(now.getTime() - 2 * 60 * 60_000),
    );

    writeFileSync(join(journalDir, "c.md"), "entry c");
    utimesSync(
      join(journalDir, "c.md"),
      new Date(now.getTime() - 3 * 24 * 60 * 60_000),
      new Date(now.getTime() - 3 * 24 * 60 * 60_000),
    );

    // maxEntries = 3 matches the number of files, so window is full
    const result = buildJournalContext(3)!;
    expect(result).toContain("## a.md — MOST RECENT");
    expect(result).toContain("## c.md — LEAVING CONTEXT");
    expect(result).toContain(
      "NOTE: This is the oldest entry in your active context.",
    );
    expect(result).toContain(
      "carry forward anything from here that still matters to you",
    );
  });

  test("does NOT mark oldest entry with LEAVING CONTEXT when window is not full", () => {
    const now = new Date();

    writeFileSync(join(journalDir, "a.md"), "entry a");
    utimesSync(
      join(journalDir, "a.md"),
      new Date(now.getTime() - 60_000),
      new Date(now.getTime() - 60_000),
    );

    writeFileSync(join(journalDir, "b.md"), "entry b");
    utimesSync(
      join(journalDir, "b.md"),
      new Date(now.getTime() - 2 * 60 * 60_000),
      new Date(now.getTime() - 2 * 60 * 60_000),
    );

    // maxEntries = 5, only 2 files — window is NOT full
    const result = buildJournalContext(5)!;
    expect(result).toContain("## a.md — MOST RECENT");
    expect(result).not.toContain("LEAVING CONTEXT");
  });

  test("limits entries to maxEntries", () => {
    const now = new Date();

    for (let i = 0; i < 5; i++) {
      const filename = `entry-${i}.md`;
      writeFileSync(join(journalDir, filename), `content ${i}`);
      const time = new Date(now.getTime() - i * 60 * 60_000);
      utimesSync(join(journalDir, filename), time, time);
    }

    const result = buildJournalContext(3)!;
    // Should contain only 3 entries (entry-0, entry-1, entry-2)
    expect(result).toContain("entry-0.md");
    expect(result).toContain("entry-1.md");
    expect(result).toContain("entry-2.md");
    expect(result).not.toContain("entry-3.md");
    expect(result).not.toContain("entry-4.md");
  });

  test("maxEntries=1 with exactly one entry marks it MOST RECENT, not LEAVING CONTEXT", () => {
    writeFileSync(join(journalDir, "solo.md"), "only entry");
    const result = buildJournalContext(1)!;
    expect(result).toContain("## solo.md — MOST RECENT");
    expect(result).not.toContain("LEAVING CONTEXT");
  });

  test("includes relative timestamps in headers", () => {
    const now = new Date();

    writeFileSync(join(journalDir, "recent.md"), "recent content");
    const recentTime = new Date(now.getTime() - 3 * 60 * 60_000);
    utimesSync(join(journalDir, "recent.md"), recentTime, recentTime);

    const result = buildJournalContext(10)!;
    expect(result).toContain("3 hours ago");
  });

  test("middle entries have plain headers with relative time", () => {
    const now = new Date();

    writeFileSync(join(journalDir, "first.md"), "first");
    utimesSync(
      join(journalDir, "first.md"),
      new Date(now.getTime() - 60_000),
      new Date(now.getTime() - 60_000),
    );

    writeFileSync(join(journalDir, "middle.md"), "middle");
    utimesSync(
      join(journalDir, "middle.md"),
      new Date(now.getTime() - 2 * 60 * 60_000),
      new Date(now.getTime() - 2 * 60 * 60_000),
    );

    writeFileSync(join(journalDir, "last.md"), "last");
    utimesSync(
      join(journalDir, "last.md"),
      new Date(now.getTime() - 3 * 24 * 60 * 60_000),
      new Date(now.getTime() - 3 * 24 * 60 * 60_000),
    );

    const result = buildJournalContext(3)!;
    // Middle entry should have plain header format (no MOST RECENT, no LEAVING CONTEXT)
    expect(result).toMatch(/## middle\.md \(\d+ hours? ago\)/);
  });
});
