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
});
