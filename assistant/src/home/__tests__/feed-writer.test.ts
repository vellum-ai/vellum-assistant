import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import type { FeedItem } from "../feed-writer.js";
import { readFeedItems, writeFeedItems } from "../feed-writer.js";

// ---------------------------------------------------------------------------
// Temp directory scaffold
// ---------------------------------------------------------------------------

let testDir: string;

beforeAll(() => {
  testDir = mkdtempSync(join(tmpdir(), "feed-writer-test-"));
});

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true });
});

// Each test gets its own workspace subdirectory to avoid cross-contamination
let wsCounter = 0;
function freshWorkspace(): string {
  wsCounter++;
  const ws = join(testDir, `ws-${wsCounter}`);
  mkdirSync(ws, { recursive: true });
  return ws;
}

// ---------------------------------------------------------------------------
// Sample data
// ---------------------------------------------------------------------------

function sampleItem(overrides?: Partial<FeedItem>): FeedItem {
  return {
    id: "item-1",
    type: "nudge",
    priority: 50,
    title: "Test nudge",
    summary: "A test feed item",
    timestamp: "2026-04-07T12:00:00.000Z",
    status: "new",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("readFeedItems", () => {
  test("returns empty feed when file does not exist", async () => {
    const ws = freshWorkspace();
    const result = await readFeedItems(ws);
    expect(result).toEqual({ version: 1, lastUpdated: "", items: [] });
  });
});

describe("writeFeedItems", () => {
  test("write + read roundtrip preserves data", async () => {
    const ws = freshWorkspace();
    const items: FeedItem[] = [
      sampleItem(),
      sampleItem({
        id: "item-2",
        type: "digest",
        priority: 80,
        title: "Digest item",
        summary: "Another item",
        status: "seen",
        actions: [{ id: "act-1", label: "Open" }],
      }),
    ];

    await writeFeedItems(ws, items);
    const result = await readFeedItems(ws);

    expect(result.version).toBe(1);
    expect(result.lastUpdated).toBeTruthy();
    expect(result.items).toHaveLength(2);
    expect(result.items[0].id).toBe("item-1");
    expect(result.items[1].id).toBe("item-2");
    expect(result.items[1].actions).toEqual([{ id: "act-1", label: "Open" }]);
  });

  test("creates data/ directory if missing", async () => {
    const ws = freshWorkspace();
    const dataDir = join(ws, "data");

    expect(existsSync(dataDir)).toBe(false);

    await writeFeedItems(ws, [sampleItem()]);

    expect(existsSync(dataDir)).toBe(true);
    expect(existsSync(join(dataDir, "home-feed.json"))).toBe(true);
  });

  test("atomic write uses temp file + rename (no leftover temp files)", async () => {
    const ws = freshWorkspace();

    await writeFeedItems(ws, [sampleItem()]);

    const dataDir = join(ws, "data");
    const files = readdirSync(dataDir);
    // Only the final file should remain — no .tmp-* files
    expect(files).toEqual(["home-feed.json"]);
  });

  test("overwrites existing feed file", async () => {
    const ws = freshWorkspace();

    await writeFeedItems(ws, [sampleItem({ id: "first" })]);
    await writeFeedItems(ws, [sampleItem({ id: "second" })]);

    const result = await readFeedItems(ws);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].id).toBe("second");
  });
});
