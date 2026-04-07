/**
 * Tests for the workspace allowlist module used by `POST /v1/export`.
 *
 * Validates that `collectWorkspaceData` honors the time + conversationId
 * filters, enforces the workspace cap, ignores malformed conversation
 * directory names, and never throws.
 *
 * The shared `test-preload.ts` sets `VELLUM_WORKSPACE_DIR` to a per-file
 * temp directory before any test code runs, so `getConversationsDir()`
 * already resolves under our temp workspace. We just seed the
 * `conversations/` subdirectory before each test and tear it down
 * afterwards.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { getConversationsDir } from "../../../../util/platform.js";
import { collectWorkspaceData } from "../workspace-allowlist.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CONV_DIRS = {
  jan10: "2025-01-10T00-00-00.000Z_conv-jan10",
  jan15: "2025-01-15T00-00-00.000Z_conv-jan15",
  jan20: "2025-01-20T00-00-00.000Z_conv-jan20",
  jan25: "2025-01-25T00-00-00.000Z_conv-jan25",
  invalid: "not-a-valid-name",
  jan15Attachments: "2025-01-15T00-00-00.000Z_conv-jan15-with-attachments",
} as const;

function seedConversations(): void {
  const conversationsDir = getConversationsDir();
  mkdirSync(conversationsDir, { recursive: true });

  // Four canonical conversation dirs with a meta + messages file each.
  for (const name of [
    CONV_DIRS.jan10,
    CONV_DIRS.jan15,
    CONV_DIRS.jan20,
    CONV_DIRS.jan25,
  ]) {
    const dir = join(conversationsDir, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "meta.json"),
      JSON.stringify({ name }, null, 2),
      "utf-8",
    );
    writeFileSync(
      join(dir, "messages.jsonl"),
      `{"role":"user","content":"hi from ${name}"}\n`,
      "utf-8",
    );
  }

  // Malformed dir — should be skipped because parseConversationDirName
  // returns null for it.
  const invalidDir = join(conversationsDir, CONV_DIRS.invalid);
  mkdirSync(invalidDir, { recursive: true });
  writeFileSync(join(invalidDir, "junk.txt"), "should not be copied", "utf-8");

  // A separate canonical conversation dir whose id is *not* an exact match
  // for "conv-jan15" — used to verify that the conversationId filter does
  // exact matching, not substring matching.
  const attachmentsDir = join(conversationsDir, CONV_DIRS.jan15Attachments);
  mkdirSync(join(attachmentsDir, "attachments"), { recursive: true });
  writeFileSync(
    join(attachmentsDir, "meta.json"),
    JSON.stringify({ name: CONV_DIRS.jan15Attachments }, null, 2),
    "utf-8",
  );
  writeFileSync(
    join(attachmentsDir, "attachments", "photo.png"),
    "PNGDATA",
    "utf-8",
  );
}

let staging: string;

beforeEach(() => {
  // Fresh staging directory for each test.
  staging = mkdtempSync(join(tmpdir(), "ws-allowlist-staging-"));
  // Reset the workspace's conversations dir between tests.
  const conversationsDir = getConversationsDir();
  rmSync(conversationsDir, { recursive: true, force: true });
});

afterEach(() => {
  try {
    rmSync(staging, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
  // Wipe the workspace's conversations dir so test files can't bleed into
  // each other.
  try {
    rmSync(getConversationsDir(), { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("collectWorkspaceData — conversations entry", () => {
  test("copies all valid conversation dirs when no filters are set", () => {
    seedConversations();

    const result = collectWorkspaceData({ staging });

    expect(result.entries).toHaveLength(1);
    const [entry] = result.entries;
    expect(entry.entry).toBe("conversations");
    // Four valid + one extra canonical (jan15-with-attachments) = 5
    expect(entry.itemCount).toBe(5);
    expect(entry.skippedDueToCap).toBe(0);
    expect(entry.bytes).toBeGreaterThan(0);
    expect(result.totalBytes).toBe(entry.bytes);

    const copied = readdirSync(join(staging, "workspace", "conversations"));
    expect(copied).toContain(CONV_DIRS.jan10);
    expect(copied).toContain(CONV_DIRS.jan15);
    expect(copied).toContain(CONV_DIRS.jan20);
    expect(copied).toContain(CONV_DIRS.jan25);
    expect(copied).toContain(CONV_DIRS.jan15Attachments);
    // Malformed dir is skipped.
    expect(copied).not.toContain(CONV_DIRS.invalid);
  });

  test("startTime filter excludes earlier conversations", () => {
    seedConversations();
    const startTime = Date.parse("2025-01-14T00:00:00Z");

    const result = collectWorkspaceData({ staging, startTime });

    const copied = readdirSync(join(staging, "workspace", "conversations"));
    expect(copied).not.toContain(CONV_DIRS.jan10);
    expect(copied).toContain(CONV_DIRS.jan15);
    expect(copied).toContain(CONV_DIRS.jan20);
    expect(copied).toContain(CONV_DIRS.jan25);
    // jan15-with-attachments has the same timestamp as jan15 → still included.
    expect(copied).toContain(CONV_DIRS.jan15Attachments);
    expect(result.entries[0].itemCount).toBe(4);
  });

  test("endTime filter excludes later conversations", () => {
    seedConversations();
    const endTime = Date.parse("2025-01-22T00:00:00Z");

    const result = collectWorkspaceData({ staging, endTime });

    const copied = readdirSync(join(staging, "workspace", "conversations"));
    expect(copied).toContain(CONV_DIRS.jan10);
    expect(copied).toContain(CONV_DIRS.jan15);
    expect(copied).toContain(CONV_DIRS.jan20);
    expect(copied).not.toContain(CONV_DIRS.jan25);
    expect(copied).toContain(CONV_DIRS.jan15Attachments);
    expect(result.entries[0].itemCount).toBe(4);
  });

  test("startTime + endTime keeps only conversations inside the window", () => {
    seedConversations();
    const startTime = Date.parse("2025-01-14T00:00:00Z");
    const endTime = Date.parse("2025-01-22T00:00:00Z");

    const result = collectWorkspaceData({ staging, startTime, endTime });

    const copied = readdirSync(join(staging, "workspace", "conversations"));
    expect(copied).not.toContain(CONV_DIRS.jan10);
    expect(copied).toContain(CONV_DIRS.jan15);
    expect(copied).toContain(CONV_DIRS.jan20);
    expect(copied).not.toContain(CONV_DIRS.jan25);
    // jan15-with-attachments shares the Jan 15 timestamp → still included.
    expect(copied).toContain(CONV_DIRS.jan15Attachments);
    expect(result.entries[0].itemCount).toBe(3);
  });

  test("conversationId filter matches exactly (no substrings)", () => {
    seedConversations();

    const result = collectWorkspaceData({
      staging,
      conversationId: "conv-jan15",
    });

    const copied = readdirSync(join(staging, "workspace", "conversations"));
    expect(copied).toEqual([CONV_DIRS.jan15]);
    // Crucially, the substring-match attachments dir is NOT included.
    expect(copied).not.toContain(CONV_DIRS.jan15Attachments);
    expect(result.entries[0].itemCount).toBe(1);
  });

  test("conversationId + time filter intersection can be empty", () => {
    seedConversations();

    const result = collectWorkspaceData({
      staging,
      conversationId: "conv-jan15",
      // Window that excludes Jan 15.
      startTime: Date.parse("2025-01-16T00:00:00Z"),
      endTime: Date.parse("2025-01-22T00:00:00Z"),
    });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].itemCount).toBe(0);
    expect(result.entries[0].bytes).toBe(0);
    expect(result.totalBytes).toBe(0);
    // No directory should have been created because nothing was copied.
    expect(existsSync(join(staging, "workspace", "conversations"))).toBe(false);
  });

  test("includes conversation when createdAt is outside window but a message ts is inside", () => {
    // Conversation was created on Jan 10 but received a message on
    // Jan 18. With a [Jan 14, Jan 22] window, the directory-name parse
    // says "out of window" but the message scan should keep it.
    const conversationsDir = getConversationsDir();
    mkdirSync(conversationsDir, { recursive: true });
    const dir = join(conversationsDir, CONV_DIRS.jan10);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "meta.json"),
      JSON.stringify({ name: CONV_DIRS.jan10 }, null, 2),
      "utf-8",
    );
    writeFileSync(
      join(dir, "messages.jsonl"),
      [
        '{"role":"user","ts":"2025-01-10T00:00:00.000Z","content":"created"}',
        '{"role":"user","ts":"2025-01-18T12:00:00.000Z","content":"in window"}',
        "",
      ].join("\n"),
      "utf-8",
    );

    const result = collectWorkspaceData({
      staging,
      startTime: Date.parse("2025-01-14T00:00:00Z"),
      endTime: Date.parse("2025-01-22T00:00:00Z"),
    });

    expect(result.entries[0].itemCount).toBe(1);
    const copied = readdirSync(join(staging, "workspace", "conversations"));
    expect(copied).toEqual([CONV_DIRS.jan10]);
  });

  test("excludes conversation when createdAt and every message ts are outside the window", () => {
    // Conversation created on Jan 10 with messages only before/after the
    // [Jan 14, Jan 22] window. Both filters miss → directory must be skipped.
    const conversationsDir = getConversationsDir();
    mkdirSync(conversationsDir, { recursive: true });
    const dir = join(conversationsDir, CONV_DIRS.jan10);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "meta.json"),
      JSON.stringify({ name: CONV_DIRS.jan10 }, null, 2),
      "utf-8",
    );
    writeFileSync(
      join(dir, "messages.jsonl"),
      [
        '{"role":"user","ts":"2025-01-10T00:00:00.000Z","content":"too early"}',
        '{"role":"user","ts":"2025-01-12T00:00:00.000Z","content":"still early"}',
        '{"role":"user","ts":"2025-01-25T00:00:00.000Z","content":"too late"}',
        "",
      ].join("\n"),
      "utf-8",
    );

    const result = collectWorkspaceData({
      staging,
      startTime: Date.parse("2025-01-14T00:00:00Z"),
      endTime: Date.parse("2025-01-22T00:00:00Z"),
    });

    expect(result.entries[0].itemCount).toBe(0);
    expect(existsSync(join(staging, "workspace", "conversations"))).toBe(false);
  });

  test("includes conversation when createdAt is in window even if messages.jsonl is missing", () => {
    // Conversation created on Jan 15 with no messages.jsonl yet (e.g.
    // brand-new conversation). The cheap createdAt check is enough; we
    // should never even open messages.jsonl.
    const conversationsDir = getConversationsDir();
    mkdirSync(conversationsDir, { recursive: true });
    const dir = join(conversationsDir, CONV_DIRS.jan15);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "meta.json"),
      JSON.stringify({ name: CONV_DIRS.jan15 }, null, 2),
      "utf-8",
    );

    const result = collectWorkspaceData({
      staging,
      startTime: Date.parse("2025-01-14T00:00:00Z"),
      endTime: Date.parse("2025-01-22T00:00:00Z"),
    });

    expect(result.entries[0].itemCount).toBe(1);
    const copied = readdirSync(join(staging, "workspace", "conversations"));
    expect(copied).toEqual([CONV_DIRS.jan15]);
  });

  test("excludes conversation when createdAt is out of window and messages.jsonl is missing", () => {
    // Conversation created on Jan 10 (out of window) with no
    // messages.jsonl at all. Both checks miss → skip.
    const conversationsDir = getConversationsDir();
    mkdirSync(conversationsDir, { recursive: true });
    const dir = join(conversationsDir, CONV_DIRS.jan10);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "meta.json"),
      JSON.stringify({ name: CONV_DIRS.jan10 }, null, 2),
      "utf-8",
    );

    const result = collectWorkspaceData({
      staging,
      startTime: Date.parse("2025-01-14T00:00:00Z"),
      endTime: Date.parse("2025-01-22T00:00:00Z"),
    });

    expect(result.entries[0].itemCount).toBe(0);
    expect(existsSync(join(staging, "workspace", "conversations"))).toBe(false);
  });

  test("canonical-named symlinks are rejected before the message-window scan runs", () => {
    // Symlink creation requires elevated permissions on Windows; skip
    // there to avoid spurious failures in CI on Windows hosts.
    if (process.platform === "win32") return;

    // Create an external directory containing a messages.jsonl whose
    // single message timestamp falls inside the requested window. If
    // the message-window scan ever follows the symlink, it would
    // mistakenly include the symlink because the in-window message
    // would "match". The boundary guard must reject the symlink first
    // so the scan never reads outside `conversations/`.
    const externalTarget = mkdtempSync(
      join(tmpdir(), "ws-allowlist-symlink-msg-"),
    );
    try {
      writeFileSync(
        join(externalTarget, "meta.json"),
        JSON.stringify({ name: "evil" }, null, 2),
        "utf-8",
      );
      writeFileSync(
        join(externalTarget, "messages.jsonl"),
        '{"role":"user","ts":"2025-01-18T12:00:00.000Z","content":"in window"}\n',
        "utf-8",
      );

      const conversationsDir = getConversationsDir();
      mkdirSync(conversationsDir, { recursive: true });

      // Canonical name with createdAt OUTSIDE the window so the cheap
      // check fails and the message-window fallback would normally fire.
      const evilName = "2025-01-10T00-00-00.000Z_evil-target";
      symlinkSync(externalTarget, join(conversationsDir, evilName), "dir");

      const result = collectWorkspaceData({
        staging,
        startTime: Date.parse("2025-01-14T00:00:00Z"),
        endTime: Date.parse("2025-01-22T00:00:00Z"),
      });

      // The boundary guard must reject the symlink before the message
      // scan ever opens the external messages.jsonl. Nothing must land
      // in the staging directory.
      expect(result.entries).toHaveLength(1);
      const [entry] = result.entries;
      expect(entry.itemCount).toBe(0);
      expect(entry.bytes).toBe(0);
      expect(entry.skippedDueToCap).toBe(0);
      expect(existsSync(join(staging, "workspace", "conversations"))).toBe(
        false,
      );
    } finally {
      rmSync(externalTarget, { recursive: true, force: true });
    }
  });

  test("streaming scan finds an in-window message in a large messages.jsonl", () => {
    // Build a messages.jsonl that's large enough to span multiple
    // 64 KB read chunks. Padding messages have an out-of-window ts; a
    // single in-window message is buried near the end so the scan must
    // actually traverse most of the file to find it. This exercises
    // the streaming + UTF-8 boundary handling without ever loading
    // the whole file into a single string.
    const conversationsDir = getConversationsDir();
    mkdirSync(conversationsDir, { recursive: true });
    const dir = join(conversationsDir, CONV_DIRS.jan10);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "meta.json"),
      JSON.stringify({ name: CONV_DIRS.jan10 }, null, 2),
      "utf-8",
    );

    const padLine = `{"role":"user","ts":"2025-01-10T00:00:00.000Z","content":"${"x".repeat(500)}"}`;
    const matchLine =
      '{"role":"user","ts":"2025-01-18T12:00:00.000Z","content":"hit"}';
    // ~500 padding lines + 1 match line ≈ 250 KB, well over a single
    // 64 KB chunk.
    const lines: string[] = [];
    for (let i = 0; i < 500; i++) lines.push(padLine);
    lines.push(matchLine);
    writeFileSync(
      join(dir, "messages.jsonl"),
      lines.join("\n") + "\n",
      "utf-8",
    );

    const result = collectWorkspaceData({
      staging,
      startTime: Date.parse("2025-01-14T00:00:00Z"),
      endTime: Date.parse("2025-01-22T00:00:00Z"),
    });

    expect(result.entries[0].itemCount).toBe(1);
    const copied = readdirSync(join(staging, "workspace", "conversations"));
    expect(copied).toEqual([CONV_DIRS.jan10]);
  });

  test("malformed messages.jsonl lines are silently skipped during the window scan", () => {
    // Conversation created on Jan 10 (out of window). messages.jsonl
    // has garbage on most lines but ONE valid line whose ts is in
    // window — that single valid line should be enough to keep the dir.
    const conversationsDir = getConversationsDir();
    mkdirSync(conversationsDir, { recursive: true });
    const dir = join(conversationsDir, CONV_DIRS.jan10);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "meta.json"),
      JSON.stringify({ name: CONV_DIRS.jan10 }, null, 2),
      "utf-8",
    );
    writeFileSync(
      join(dir, "messages.jsonl"),
      [
        "not json at all",
        '{"role":"user"}', // missing ts
        '{"role":"user","ts":"not-a-date"}', // ts isn't parseable
        '{"role":"user","ts":42}', // ts is wrong type
        '{"role":"user","ts":"2025-01-18T12:00:00.000Z","content":"valid"}',
        "",
      ].join("\n"),
      "utf-8",
    );

    const result = collectWorkspaceData({
      staging,
      startTime: Date.parse("2025-01-14T00:00:00Z"),
      endTime: Date.parse("2025-01-22T00:00:00Z"),
    });

    expect(result.entries[0].itemCount).toBe(1);
    const copied = readdirSync(join(staging, "workspace", "conversations"));
    expect(copied).toEqual([CONV_DIRS.jan10]);
  });

  test("byte cap enforcement skips every conversation when too tight", () => {
    seedConversations();

    // 1 byte cap is impossible to fit any seeded dir into.
    const result = collectWorkspaceData({ staging, maxBytes: 1 });

    expect(result.entries).toHaveLength(1);
    const [entry] = result.entries;
    expect(entry.itemCount).toBe(0);
    expect(entry.bytes).toBe(0);
    expect(entry.skippedDueToCap).toBe(5);
    expect(result.totalBytes).toBe(0);
    expect(existsSync(join(staging, "workspace", "conversations"))).toBe(false);
  });

  test("byte cap keeps the newest conversations first", () => {
    // Seed three dirs with distinct, non-trivial sizes and known
    // timestamps. Use a padding file per dir so the per-dir byte total
    // is predictable and large enough to push us past the cap after a
    // couple entries have been copied.
    const conversationsDir = getConversationsDir();
    mkdirSync(conversationsDir, { recursive: true });

    const PADDING_BYTES = 4000;
    const padding = "a".repeat(PADDING_BYTES);
    for (const name of [CONV_DIRS.jan10, CONV_DIRS.jan15, CONV_DIRS.jan20]) {
      const dir = join(conversationsDir, name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "pad.txt"), padding, "utf-8");
    }

    // Each dir weighs ~PADDING_BYTES. A 10 KB cap fits exactly 2 dirs
    // (but not the third).
    const result = collectWorkspaceData({
      staging,
      maxBytes: PADDING_BYTES * 2 + 500,
    });

    expect(result.entries).toHaveLength(1);
    const [entry] = result.entries;
    expect(entry.itemCount).toBe(2);
    expect(entry.skippedDueToCap).toBe(1);

    // The two newest dirs (jan20 and jan15) should have been copied;
    // jan10 (oldest) should be the one skipped due to the cap.
    const copied = readdirSync(join(staging, "workspace", "conversations"));
    expect(copied).toContain(CONV_DIRS.jan20);
    expect(copied).toContain(CONV_DIRS.jan15);
    expect(copied).not.toContain(CONV_DIRS.jan10);
  });

  test("non-directory entries with canonical-looking names are skipped", () => {
    // Make sure the conversations dir exists and seed one valid dir so
    // we can confirm the function still copies legit entries alongside
    // the bogus regular file.
    const conversationsDir = getConversationsDir();
    mkdirSync(conversationsDir, { recursive: true });

    // Seed a real canonical conversation dir so there's something to copy.
    const validDir = join(conversationsDir, CONV_DIRS.jan20);
    mkdirSync(validDir, { recursive: true });
    writeFileSync(
      join(validDir, "meta.json"),
      JSON.stringify({ name: CONV_DIRS.jan20 }, null, 2),
      "utf-8",
    );

    // Seed a REGULAR FILE whose name matches the canonical
    // `<ISO>_<conversationId>` pattern. Fill it with data that is big
    // enough to exceed the cap, to prove that the non-dir guard bails
    // before `dirSizeWithinBudget`/`cpSync` could silently copy it.
    const bogusName = "2025-01-15T00-00-00.000Z_conv-jan15-as-file";
    const bogusPath = join(conversationsDir, bogusName);
    writeFileSync(bogusPath, "x".repeat(1024 * 1024), "utf-8"); // 1 MB

    // Use a tight cap (larger than the valid dir but smaller than the
    // bogus file) to prove the bogus file is skipped before copying.
    const result = collectWorkspaceData({
      staging,
      maxBytes: 100 * 1024, // 100 KB
    });

    expect(result.entries).toHaveLength(1);
    const [entry] = result.entries;
    // Only the real conversation dir should have been copied.
    expect(entry.itemCount).toBe(1);
    // skippedDueToCap should NOT include the bogus file — it's rejected
    // by the non-dir guard, not by the cap.
    expect(entry.skippedDueToCap).toBe(0);

    const copied = readdirSync(join(staging, "workspace", "conversations"));
    expect(copied).toEqual([CONV_DIRS.jan20]);
    expect(copied).not.toContain(bogusName);
  });

  test("missing conversations dir returns an empty entry summary", () => {
    // Do NOT seed — workspace has no conversations/ subdir.
    const conversationsDir = getConversationsDir();
    rmSync(conversationsDir, { recursive: true, force: true });
    expect(existsSync(conversationsDir)).toBe(false);

    const result = collectWorkspaceData({ staging });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toEqual({
      entry: "conversations",
      itemCount: 0,
      bytes: 0,
      skippedDueToCap: 0,
    });
    expect(result.totalBytes).toBe(0);
    expect(existsSync(join(staging, "workspace"))).toBe(false);
  });

  test("recursive copy preserves nested attachments", () => {
    seedConversations();

    collectWorkspaceData({
      staging,
      conversationId: "conv-jan15-with-attachments",
    });

    const copied = readdirSync(join(staging, "workspace", "conversations"));
    expect(copied).toEqual([CONV_DIRS.jan15Attachments]);
    const photoPath = join(
      staging,
      "workspace",
      "conversations",
      CONV_DIRS.jan15Attachments,
      "attachments",
      "photo.png",
    );
    expect(existsSync(photoPath)).toBe(true);
  });

  test("skips symlinked directories to avoid infinite loops", () => {
    // Symlink creation requires elevated permissions on Windows; skip
    // there to avoid spurious failures in CI on Windows hosts.
    if (process.platform === "win32") return;

    // Seed a single canonical conversation directory and stick a
    // symlink loop inside it (`loop -> .`). `dirSizeWithinBudget` uses
    // `lstatSync` so that symlinks are skipped rather than dereferenced;
    // without this, following the symlink would recurse infinitely and
    // hang the export. We expect the function to return promptly and
    // still process the conversation directory.
    const conversationsDir = getConversationsDir();
    mkdirSync(conversationsDir, { recursive: true });

    const convDir = join(conversationsDir, CONV_DIRS.jan20);
    mkdirSync(convDir, { recursive: true });
    writeFileSync(
      join(convDir, "meta.json"),
      JSON.stringify({ name: CONV_DIRS.jan20 }, null, 2),
      "utf-8",
    );

    // Create the loop: <conv-dir>/loop -> .
    symlinkSync(".", join(convDir, "loop"), "dir");

    const startMs = Date.now();
    const result = collectWorkspaceData({ staging });
    const elapsedMs = Date.now() - startMs;

    // Sanity check: the call must complete quickly. The `lstatSync`
    // guard is what keeps this from hanging — if the recursive walker
    // were to dereference the symlink, the bun test runner would time
    // out long before this assertion ever fired.
    expect(elapsedMs).toBeLessThan(5000);

    expect(result.entries).toHaveLength(1);
    const [entry] = result.entries;
    expect(entry.entry).toBe("conversations");
    // The conversation directory should still be processed and copied;
    // we don't care whether the symlink itself was reproduced in the
    // copy — the key invariant is that the function completed.
    expect(entry.itemCount).toBe(1);
    expect(entry.skippedDueToCap).toBe(0);

    const copied = readdirSync(join(staging, "workspace", "conversations"));
    expect(copied).toContain(CONV_DIRS.jan20);
  });

  test("rejects top-level symlinks pointing outside the conversations dir", () => {
    // Symlink creation requires elevated permissions on Windows; skip
    // there to avoid spurious failures in CI on Windows hosts.
    if (process.platform === "win32") return;

    // Create a directory OUTSIDE `conversations/` that masquerades as a
    // valid conversation dir (with a `meta.json`). The allowlist guard
    // must not allow a symlink with a canonical name to escape the
    // `conversations/` boundary by dereferencing into this external
    // target.
    const externalTarget = mkdtempSync(
      join(tmpdir(), "ws-allowlist-external-"),
    );
    try {
      writeFileSync(
        join(externalTarget, "meta.json"),
        JSON.stringify({ name: "evil" }, null, 2),
        "utf-8",
      );
      writeFileSync(
        join(externalTarget, "secret.txt"),
        "should never be copied",
        "utf-8",
      );

      // Seed the conversations dir and add a symlink with a canonical
      // name pointing at the external target.
      const conversationsDir = getConversationsDir();
      mkdirSync(conversationsDir, { recursive: true });

      const evilName = "2025-01-30T00-00-00.000Z_evil-target";
      symlinkSync(externalTarget, join(conversationsDir, evilName), "dir");

      const result = collectWorkspaceData({ staging });

      // The symlink must be skipped by the top-level `lstatSync` guard.
      // Nothing from the external target should land in the staging
      // directory and the entry summary should not count it.
      expect(result.entries).toHaveLength(1);
      const [entry] = result.entries;
      expect(entry.entry).toBe("conversations");
      expect(entry.itemCount).toBe(0);
      expect(entry.skippedDueToCap).toBe(0);
      expect(entry.bytes).toBe(0);
      expect(result.totalBytes).toBe(0);

      // No staging directory should have been created because nothing
      // qualified for copying.
      expect(existsSync(join(staging, "workspace", "conversations"))).toBe(
        false,
      );
    } finally {
      rmSync(externalTarget, { recursive: true, force: true });
    }
  });
});
