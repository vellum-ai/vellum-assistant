import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
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

const {
  buildJournalContext,
  formatJournalRelativeTime,
  formatJournalAbsoluteTime,
} = await import("../prompts/journal-context.js");

/** Small delay to ensure distinct file birthtimes on APFS. */
const tick = () => Bun.sleep(5);

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
    expect(formatJournalRelativeTime(now - 3 * 60 * 60_000)).toBe(
      "3 hours ago",
    );
    expect(formatJournalRelativeTime(now - 23 * 60 * 60_000)).toBe(
      "23 hours ago",
    );
  });

  test("returns days for times between 1-6 days ago", () => {
    const now = Date.now();
    expect(formatJournalRelativeTime(now - 24 * 60 * 60_000)).toBe(
      "1 day ago",
    );
    expect(formatJournalRelativeTime(now - 3 * 24 * 60 * 60_000)).toBe(
      "3 days ago",
    );
    expect(formatJournalRelativeTime(now - 6 * 24 * 60 * 60_000)).toBe(
      "6 days ago",
    );
  });

  test("returns weeks for times 7 or more days ago", () => {
    const now = Date.now();
    expect(formatJournalRelativeTime(now - 7 * 24 * 60 * 60_000)).toBe(
      "1 week ago",
    );
    expect(formatJournalRelativeTime(now - 14 * 24 * 60 * 60_000)).toBe(
      "2 weeks ago",
    );
    expect(formatJournalRelativeTime(now - 30 * 24 * 60 * 60_000)).toBe(
      "4 weeks ago",
    );
  });
});

describe("formatJournalAbsoluteTime", () => {
  test("formats a timestamp as MM/DD/YY HH:MM", () => {
    // 2025-03-15 14:30:00
    const ts = new Date(2025, 2, 15, 14, 30, 0).getTime();
    expect(formatJournalAbsoluteTime(ts)).toBe("03/15/25 14:30");
  });

  test("zero-pads single-digit months, days, hours, and minutes", () => {
    // 2025-01-05 09:05:00
    const ts = new Date(2025, 0, 5, 9, 5, 0).getTime();
    expect(formatJournalAbsoluteTime(ts)).toBe("01/05/25 09:05");
  });

  test("handles midnight", () => {
    const ts = new Date(2025, 5, 20, 0, 0, 0).getTime();
    expect(formatJournalAbsoluteTime(ts)).toBe("06/20/25 00:00");
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
    const userDir = join(journalDir, "testuser");
    mkdirSync(userDir, { recursive: true });
    writeFileSync(join(userDir, "entry.md"), "content");
    expect(buildJournalContext(0, "testuser")).toBeNull();
  });

  test("returns null when maxEntries is negative", () => {
    const userDir = join(journalDir, "testuser");
    mkdirSync(userDir, { recursive: true });
    writeFileSync(join(userDir, "entry.md"), "content");
    expect(buildJournalContext(-1, "testuser")).toBeNull();
  });

  test("returns null when journal directory does not exist", () => {
    rmSync(journalDir, { recursive: true, force: true });
    expect(buildJournalContext(10, "testuser")).toBeNull();
  });

  test("returns null when journal directory has no .md files", () => {
    const userDir = join(journalDir, "testuser");
    mkdirSync(userDir, { recursive: true });
    writeFileSync(join(userDir, "notes.txt"), "not markdown");
    expect(buildJournalContext(10, "testuser")).toBeNull();
  });

  test("excludes README.md (case-insensitive)", () => {
    const userDir = join(journalDir, "testuser");
    mkdirSync(userDir, { recursive: true });
    writeFileSync(join(userDir, "README.md"), "readme content");
    writeFileSync(join(userDir, "readme.md"), "readme content lower");
    expect(buildJournalContext(10, "testuser")).toBeNull();
  });

  test("returns formatted journal context with single entry", () => {
    const userDir = join(journalDir, "testuser");
    mkdirSync(userDir, { recursive: true });
    writeFileSync(join(userDir, "goals.md"), "My goals for this week.");
    const result = buildJournalContext(10, "testuser");
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

  test("sorts entries by creation time, newest first", async () => {
    const userDir = join(journalDir, "testuser");
    mkdirSync(userDir, { recursive: true });
    // Small delays between writes ensure distinct birthtimes.
    writeFileSync(join(userDir, "old.md"), "old entry");
    await tick();
    writeFileSync(join(userDir, "mid.md"), "mid entry");
    await tick();
    writeFileSync(join(userDir, "new.md"), "new entry");

    const result = buildJournalContext(10, "testuser")!;
    const newIdx = result.indexOf("new.md");
    const midIdx = result.indexOf("mid.md");
    const oldIdx = result.indexOf("old.md");
    expect(newIdx).toBeLessThan(midIdx);
    expect(midIdx).toBeLessThan(oldIdx);
  });

  test("marks most recent entry with MOST RECENT", async () => {
    const userDir = join(journalDir, "testuser");
    mkdirSync(userDir, { recursive: true });
    writeFileSync(join(userDir, "older.md"), "older");
    await tick();
    writeFileSync(join(userDir, "newest.md"), "newest");

    const result = buildJournalContext(10, "testuser")!;
    expect(result).toContain("## newest.md — MOST RECENT");
    expect(result).not.toContain("## older.md — MOST RECENT");
  });

  test("marks oldest entry with LEAVING CONTEXT when window is full", async () => {
    const userDir = join(journalDir, "testuser");
    mkdirSync(userDir, { recursive: true });
    // Create in chronological order: c (oldest), b, a (newest)
    writeFileSync(join(userDir, "c.md"), "entry c");
    await tick();
    writeFileSync(join(userDir, "b.md"), "entry b");
    await tick();
    writeFileSync(join(userDir, "a.md"), "entry a");

    // maxEntries = 3 matches the number of files, so window is full
    const result = buildJournalContext(3, "testuser")!;
    expect(result).toContain("## a.md — MOST RECENT");
    expect(result).toContain("## c.md — LEAVING CONTEXT");
    expect(result).toContain(
      "NOTE: This is the oldest entry in your active context.",
    );
    expect(result).toContain(
      "carry forward anything from here that still matters to you",
    );
  });

  test("does NOT mark oldest entry with LEAVING CONTEXT when window is not full", async () => {
    const userDir = join(journalDir, "testuser");
    mkdirSync(userDir, { recursive: true });
    writeFileSync(join(userDir, "b.md"), "entry b");
    await tick();
    writeFileSync(join(userDir, "a.md"), "entry a");

    // maxEntries = 5, only 2 files — window is NOT full
    const result = buildJournalContext(5, "testuser")!;
    expect(result).toContain("## a.md — MOST RECENT");
    expect(result).not.toContain("LEAVING CONTEXT");
  });

  test("limits entries to maxEntries", async () => {
    const userDir = join(journalDir, "testuser");
    mkdirSync(userDir, { recursive: true });
    // Create files 0-4 sequentially; file 4 is newest
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(userDir, `entry-${i}.md`), `content ${i}`);
      if (i < 4) await tick();
    }

    const result = buildJournalContext(3, "testuser")!;
    // Should contain only 3 newest entries (entry-4, entry-3, entry-2)
    expect(result).toContain("entry-4.md");
    expect(result).toContain("entry-3.md");
    expect(result).toContain("entry-2.md");
    expect(result).not.toContain("entry-1.md");
    expect(result).not.toContain("entry-0.md");
  });

  test("maxEntries=1 with exactly one entry marks it MOST RECENT, not LEAVING CONTEXT", () => {
    const userDir = join(journalDir, "testuser");
    mkdirSync(userDir, { recursive: true });
    writeFileSync(join(userDir, "solo.md"), "only entry");
    const result = buildJournalContext(1, "testuser")!;
    expect(result).toContain("## solo.md — MOST RECENT");
    expect(result).not.toContain("LEAVING CONTEXT");
  });

  test("includes both absolute and relative timestamps in headers", () => {
    const userDir = join(journalDir, "testuser");
    mkdirSync(userDir, { recursive: true });
    writeFileSync(join(userDir, "recent.md"), "recent content");

    const result = buildJournalContext(10, "testuser")!;
    // File was just created, so relative time should be "just now"
    expect(result).toContain("just now");
    // Absolute time should match the file's birthtime
    const birthtime = statSync(join(userDir, "recent.md")).birthtimeMs;
    const expected = formatJournalAbsoluteTime(birthtime);
    expect(result).toContain(expected);
  });

  test("middle entries have plain headers with timestamps", async () => {
    const userDir = join(journalDir, "testuser");
    mkdirSync(userDir, { recursive: true });
    // Create in chronological order: last (oldest), middle, first (newest)
    writeFileSync(join(userDir, "last.md"), "last");
    await tick();
    writeFileSync(join(userDir, "middle.md"), "middle");
    await tick();
    writeFileSync(join(userDir, "first.md"), "first");

    const result = buildJournalContext(3, "testuser")!;
    // Middle entry should have plain header format (no MOST RECENT, no LEAVING CONTEXT)
    // Format: ## middle.md (MM/DD/YY HH:MM, <relative time>)
    expect(result).toMatch(
      /## middle\.md \(\d{2}\/\d{2}\/\d{2} \d{2}:\d{2}, .+\)/,
    );
  });

  // --- Per-user scoping tests ---

  test("reads from per-user directory when userSlug is provided", () => {
    const aliceDir = join(journalDir, "alice");
    mkdirSync(aliceDir, { recursive: true });
    writeFileSync(join(aliceDir, "thoughts.md"), "Alice's thoughts");
    writeFileSync(join(aliceDir, "plans.md"), "Alice's plans");

    const result = buildJournalContext(10, "alice");
    expect(result).not.toBeNull();
    expect(result).toContain("Alice's thoughts");
    expect(result).toContain("Alice's plans");
  });

  test("returns null when userSlug is provided but directory does not exist", () => {
    // journal/bob/ does not exist
    const result = buildJournalContext(10, "bob");
    expect(result).toBeNull();
  });

  test("returns null when no userSlug is provided", () => {
    // Even if root journal/ has entries, no slug means null
    writeFileSync(join(journalDir, "orphan.md"), "orphan entry");
    const result = buildJournalContext(10);
    expect(result).toBeNull();
  });

  test("returns null when userSlug is null", () => {
    writeFileSync(join(journalDir, "orphan.md"), "orphan entry");
    const result = buildJournalContext(10, null);
    expect(result).toBeNull();
  });

  test("includes write-path directive in header when userSlug is provided", () => {
    const aliceDir = join(journalDir, "alice");
    mkdirSync(aliceDir, { recursive: true });
    writeFileSync(join(aliceDir, "entry.md"), "some content");

    const result = buildJournalContext(10, "alice")!;
    expect(result).toContain("**Write new entries to:** `journal/alice/`");
  });

  test("sanitizes path-traversal in userSlug", () => {
    // basename("../etc") => "etc", so it should read from journal/etc/
    const etcDir = join(journalDir, "etc");
    mkdirSync(etcDir, { recursive: true });
    writeFileSync(join(etcDir, "safe.md"), "safe content");

    const result = buildJournalContext(10, "../etc");
    expect(result).not.toBeNull();
    expect(result).toContain("safe content");
    // Should reference the sanitized path, not the traversal attempt
    expect(result).toContain("`journal/etc/`");
  });
});
