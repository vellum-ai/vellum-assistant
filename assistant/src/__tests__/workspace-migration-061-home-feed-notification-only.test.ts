/**
 * Tests for workspace migration `061-home-feed-notification-only`.
 *
 * The migration rewrites `<workspace>/data/home-feed.json` from the
 * legacy v1 schema (mixed `nudge | digest | action | thread` items
 * with `source`/`author`/`minTimeAway`) into the collapsed v2 schema
 * (single `notification` type with no source/author/minTimeAway).
 *
 * Cases covered (matching the PR 15 acceptance criteria):
 *   1. Missing file → no-op (no error).
 *   2. v1 file with mixed types → only `action` items survive,
 *      retyped to `notification`, source/author/minTimeAway dropped.
 *   3. v1 file with all `action` items → all kept, all retyped, fields
 *      stripped.
 *   4. v2 file → no-op (idempotent — file unchanged).
 *   5. Two consecutive runs on a v1 file → second run is a no-op.
 *
 * Plus a few defence-in-depth cases: malformed JSON, non-object root.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { homeFeedNotificationOnlyMigration } from "../workspace/migrations/061-home-feed-notification-only.js";

let workspaceDir: string;
let feedPath: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "vellum-migration-061-test-"));
  feedPath = join(workspaceDir, "data", "home-feed.json");
});

afterEach(() => {
  if (existsSync(workspaceDir)) {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

function writeFeedFile(contents: unknown): void {
  mkdirSync(join(workspaceDir, "data"), { recursive: true });
  writeFileSync(feedPath, JSON.stringify(contents, null, 2), "utf-8");
}

function readFeedFile(): {
  version: number;
  items: Array<Record<string, unknown>>;
  updatedAt: string;
} {
  return JSON.parse(readFileSync(feedPath, "utf-8"));
}

function makeBaseV1Item(
  overrides: Record<string, unknown> & { id: string; type: string },
): Record<string, unknown> {
  return {
    priority: 50,
    title: "Test title",
    summary: "Test summary",
    timestamp: "2026-04-14T12:00:00.000Z",
    status: "new",
    author: "platform",
    createdAt: "2026-04-14T12:00:00.000Z",
    ...overrides,
  };
}

describe("workspace migration 061-home-feed-notification-only", () => {
  test("has the expected id and description", () => {
    expect(homeFeedNotificationOnlyMigration.id).toBe(
      "home-feed-notification-only-v2",
    );
    expect(homeFeedNotificationOnlyMigration.description).toContain("v2");
  });

  test("missing file is a no-op (no error, no file created)", () => {
    expect(existsSync(feedPath)).toBe(false);

    expect(() =>
      homeFeedNotificationOnlyMigration.run(workspaceDir),
    ).not.toThrow();

    expect(existsSync(feedPath)).toBe(false);
  });

  test("v1 file with mixed types keeps only action entries, rewrites them as notification, strips legacy fields", () => {
    writeFeedFile({
      version: 1,
      updatedAt: "2026-04-14T12:00:00.000Z",
      items: [
        makeBaseV1Item({
          id: "nudge-1",
          type: "nudge",
          source: "gmail",
          minTimeAway: 3600,
        }),
        makeBaseV1Item({
          id: "digest-1",
          type: "digest",
          source: "gmail",
        }),
        makeBaseV1Item({
          id: "action-1",
          type: "action",
          source: "assistant",
          author: "assistant",
          minTimeAway: 0,
          urgency: "high",
          conversationId: "conv-abc",
        }),
        makeBaseV1Item({
          id: "thread-1",
          type: "thread",
        }),
        makeBaseV1Item({
          id: "action-2",
          type: "action",
          source: "gmail",
          author: "platform",
        }),
      ],
    });

    homeFeedNotificationOnlyMigration.run(workspaceDir);

    const out = readFeedFile();
    expect(out.version).toBe(2);
    const ids = out.items.map((i) => i.id).sort();
    expect(ids).toEqual(["action-1", "action-2"]);

    for (const item of out.items) {
      expect(item.type).toBe("notification");
      expect(item.source).toBeUndefined();
      expect(item.author).toBeUndefined();
      expect(item.minTimeAway).toBeUndefined();
    }

    // Optional fields that should be carried through.
    const action1 = out.items.find((i) => i.id === "action-1")!;
    expect(action1.urgency).toBe("high");
    expect(action1.conversationId).toBe("conv-abc");
    expect(action1.title).toBe("Test title");
    expect(action1.priority).toBe(50);

    expect(typeof out.updatedAt).toBe("string");
    expect(Number.isNaN(Date.parse(out.updatedAt))).toBe(false);
  });

  test("v1 file with only action entries keeps every item, retyped and stripped", () => {
    writeFeedFile({
      version: 1,
      updatedAt: "2026-04-14T12:00:00.000Z",
      items: [
        makeBaseV1Item({
          id: "a-1",
          type: "action",
          source: "gmail",
          author: "assistant",
          minTimeAway: 5,
        }),
        makeBaseV1Item({
          id: "a-2",
          type: "action",
          source: "slack",
          author: "platform",
        }),
        makeBaseV1Item({
          id: "a-3",
          type: "action",
          author: "assistant",
        }),
      ],
    });

    homeFeedNotificationOnlyMigration.run(workspaceDir);

    const out = readFeedFile();
    expect(out.version).toBe(2);
    expect(out.items).toHaveLength(3);
    for (const item of out.items) {
      expect(item.type).toBe("notification");
      expect(item.source).toBeUndefined();
      expect(item.author).toBeUndefined();
      expect(item.minTimeAway).toBeUndefined();
    }
    const ids = out.items.map((i) => i.id).sort();
    expect(ids).toEqual(["a-1", "a-2", "a-3"]);
  });

  test("v2 file is a no-op (file content and mtime untouched)", () => {
    const v2 = {
      version: 2,
      updatedAt: "2026-04-14T12:00:00.000Z",
      items: [
        {
          id: "n-1",
          type: "notification",
          priority: 70,
          title: "Hello",
          summary: "World",
          timestamp: "2026-04-14T12:00:00.000Z",
          status: "new",
          createdAt: "2026-04-14T12:00:00.000Z",
        },
      ],
    };
    writeFeedFile(v2);
    const before = readFileSync(feedPath, "utf-8");
    const beforeStat = statSync(feedPath);

    homeFeedNotificationOnlyMigration.run(workspaceDir);

    const after = readFileSync(feedPath, "utf-8");
    expect(after).toBe(before);
    // The migration must short-circuit before writing — same mtime.
    expect(statSync(feedPath).mtimeMs).toBe(beforeStat.mtimeMs);
  });

  test("idempotent: second run on a freshly migrated file is a no-op", () => {
    writeFeedFile({
      version: 1,
      updatedAt: "2026-04-14T12:00:00.000Z",
      items: [
        makeBaseV1Item({
          id: "a-1",
          type: "action",
          source: "gmail",
          author: "assistant",
        }),
        makeBaseV1Item({ id: "n-1", type: "nudge", source: "gmail" }),
      ],
    });

    homeFeedNotificationOnlyMigration.run(workspaceDir);
    const afterFirst = readFileSync(feedPath, "utf-8");
    const afterFirstStat = statSync(feedPath);

    homeFeedNotificationOnlyMigration.run(workspaceDir);
    const afterSecond = readFileSync(feedPath, "utf-8");

    expect(afterSecond).toBe(afterFirst);
    expect(statSync(feedPath).mtimeMs).toBe(afterFirstStat.mtimeMs);
  });

  // ── Defensive / edge cases ─────────────────────────────────────────

  test("malformed JSON is a no-op (does not throw, leaves file alone)", () => {
    mkdirSync(join(workspaceDir, "data"), { recursive: true });
    writeFileSync(feedPath, "{not valid json", "utf-8");
    const before = readFileSync(feedPath, "utf-8");

    expect(() =>
      homeFeedNotificationOnlyMigration.run(workspaceDir),
    ).not.toThrow();

    expect(readFileSync(feedPath, "utf-8")).toBe(before);
  });

  test("non-object root is a no-op", () => {
    writeFeedFile([1, 2, 3]);
    const before = readFileSync(feedPath, "utf-8");

    expect(() =>
      homeFeedNotificationOnlyMigration.run(workspaceDir),
    ).not.toThrow();

    expect(readFileSync(feedPath, "utf-8")).toBe(before);
  });

  test("v1 entries missing required fields are dropped silently", () => {
    writeFeedFile({
      version: 1,
      updatedAt: "2026-04-14T12:00:00.000Z",
      items: [
        // Missing required `title` — must be dropped.
        {
          id: "broken",
          type: "action",
          priority: 50,
          summary: "Has summary but no title",
          timestamp: "2026-04-14T12:00:00.000Z",
          status: "new",
          createdAt: "2026-04-14T12:00:00.000Z",
        },
        // Healthy action — must survive.
        makeBaseV1Item({ id: "ok", type: "action", source: "gmail" }),
      ],
    });

    homeFeedNotificationOnlyMigration.run(workspaceDir);

    const out = readFeedFile();
    expect(out.version).toBe(2);
    expect(out.items.map((i) => i.id)).toEqual(["ok"]);
  });

  test("down() is a no-op (lossy migration)", () => {
    writeFeedFile({
      version: 1,
      updatedAt: "2026-04-14T12:00:00.000Z",
      items: [makeBaseV1Item({ id: "a", type: "action" })],
    });
    homeFeedNotificationOnlyMigration.run(workspaceDir);
    const after = readFileSync(feedPath, "utf-8");

    expect(() =>
      homeFeedNotificationOnlyMigration.down(workspaceDir),
    ).not.toThrow();

    // The forward migration's output is preserved.
    expect(readFileSync(feedPath, "utf-8")).toBe(after);
  });
});
