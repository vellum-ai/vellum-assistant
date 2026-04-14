import * as fs from "node:fs";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";

import { DAEMON_INTERNAL_ASSISTANT_ID } from "../../runtime/assistant-scope.js";

// ─── assistantEventHub mock ────────────────────────────────────────────
// We spy on `publish` so the SSE-publish test can assert the writer
// fires a `home_feed_updated` event with the correct `newItemCount`.
// Other tests don't care about the spy but the mock still needs to be
// in place before the writer module is imported so the dynamic import
// picks it up.
// Typed loosely so the mock's inferred call-signature doesn't force
// us to thread the full `AssistantEvent` type through the tests.
const publishSpy = mock<(event: unknown) => Promise<void>>(async () => {});

mock.module("../../runtime/assistant-event-hub.js", () => ({
  assistantEventHub: {
    publish: publishSpy,
    // Minimal stubs — the writer only touches `.publish`, but the
    // hub's real shape has more fields. Tests never call them.
    subscribe: () => () => {},
  },
}));

// Dynamic import so the module resolves after the mock above is in
// place. Bun's `mock.module` needs to run before the real import is
// evaluated for the mock to take effect.
const {
  HOME_FEED_FILENAME,
  HOME_FEED_VERSION,
  MAX_ACTIONS_PER_SOURCE,
  appendFeedItem,
  getHomeFeedPath,
  patchFeedItemStatus,
  readHomeFeed,
} = await import("../feed-writer.js");

type FeedItemType = "nudge" | "digest" | "action" | "thread";
type FeedItemAuthor = "assistant" | "platform";
type FeedItemStatus = "new" | "seen" | "acted_on";
type FeedItemSource = "gmail" | "slack" | "calendar" | "assistant";

interface TestFeedItem {
  id: string;
  type: FeedItemType;
  priority: number;
  title: string;
  summary: string;
  source?: FeedItemSource;
  timestamp: string;
  status: FeedItemStatus;
  expiresAt?: string;
  author: FeedItemAuthor;
  createdAt: string;
}

function makeItem(
  overrides: Partial<TestFeedItem> & { id: string },
): TestFeedItem {
  return {
    type: "nudge",
    priority: 50,
    title: "Test",
    summary: "Test summary",
    timestamp: "2026-04-14T12:00:00.000Z",
    status: "new",
    author: "platform",
    createdAt: "2026-04-14T12:00:00.000Z",
    ...overrides,
  };
}

let workspaceDir: string;
let origWorkspaceDir: string | undefined;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "vellum-hfw-"));
  origWorkspaceDir = process.env.VELLUM_WORKSPACE_DIR;
  process.env.VELLUM_WORKSPACE_DIR = workspaceDir;
  publishSpy.mockClear();
});

afterEach(() => {
  if (origWorkspaceDir === undefined) {
    delete process.env.VELLUM_WORKSPACE_DIR;
  } else {
    process.env.VELLUM_WORKSPACE_DIR = origWorkspaceDir;
  }
  try {
    rmSync(workspaceDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

function readFileJson(): {
  version: number;
  items: TestFeedItem[];
  updatedAt: string;
} {
  const raw = readFileSync(getHomeFeedPath(), "utf-8");
  return JSON.parse(raw);
}

describe("feed-writer", () => {
  describe("getHomeFeedPath", () => {
    test("returns <workspace>/data/home-feed.json", () => {
      expect(getHomeFeedPath()).toBe(
        join(workspaceDir, "data", HOME_FEED_FILENAME),
      );
    });
  });

  describe("readHomeFeed", () => {
    test("missing file returns an empty v1 HomeFeedFile", () => {
      const feed = readHomeFeed();
      expect(feed.version).toBe(HOME_FEED_VERSION);
      expect(feed.items).toEqual([]);
      expect(feed.updatedAt).toBe(new Date(0).toISOString());
    });

    test("filters out items whose expiresAt is in the past", () => {
      mkdirSync(join(workspaceDir, "data"), { recursive: true });
      const past = new Date(Date.now() - 60_000).toISOString();
      const future = new Date(Date.now() + 60_000).toISOString();
      const file = {
        version: 1,
        updatedAt: "2026-04-14T12:00:00.000Z",
        items: [
          makeItem({
            id: "expired",
            type: "action",
            expiresAt: past,
          }),
          makeItem({
            id: "live",
            type: "action",
            expiresAt: future,
          }),
        ],
      };
      writeFileSync(getHomeFeedPath(), JSON.stringify(file, null, 2), "utf-8");

      const feed = readHomeFeed();
      expect(feed.items).toHaveLength(1);
      expect(feed.items[0]!.id).toBe("live");
    });

    test("corrupt JSON returns an empty feed", () => {
      mkdirSync(join(workspaceDir, "data"), { recursive: true });
      writeFileSync(getHomeFeedPath(), "{not valid", "utf-8");
      const feed = readHomeFeed();
      expect(feed.items).toEqual([]);
    });
  });

  describe("appendFeedItem", () => {
    test("appends a single nudge to disk", async () => {
      await appendFeedItem(
        makeItem({
          id: "nudge-1",
          type: "nudge",
          source: "gmail",
          title: "New email",
          summary: "You have a new email",
        }),
      );
      const decoded = readFileJson();
      expect(decoded.version).toBe(1);
      expect(decoded.items).toHaveLength(1);
      expect(decoded.items[0]!.id).toBe("nudge-1");
      expect(decoded.items[0]!.title).toBe("New email");
    });

    test("second digest from the same source replaces the first", async () => {
      await appendFeedItem(
        makeItem({
          id: "digest-old",
          type: "digest",
          source: "gmail",
          title: "Old digest",
          createdAt: "2026-04-14T10:00:00.000Z",
        }),
      );
      await appendFeedItem(
        makeItem({
          id: "digest-new",
          type: "digest",
          source: "gmail",
          title: "New digest",
          createdAt: "2026-04-14T11:00:00.000Z",
        }),
      );

      const decoded = readFileJson();
      const digests = decoded.items.filter((i) => i.type === "digest");
      expect(digests).toHaveLength(1);
      expect(digests[0]!.id).toBe("digest-new");
      expect(digests[0]!.title).toBe("New digest");
    });

    test("assistant nudge overwrites an existing platform nudge for the same source", async () => {
      await appendFeedItem(
        makeItem({
          id: "platform-nudge",
          type: "nudge",
          source: "slack",
          author: "platform",
          title: "Platform baseline",
        }),
      );
      await appendFeedItem(
        makeItem({
          id: "assistant-nudge",
          type: "nudge",
          source: "slack",
          author: "assistant",
          title: "Assistant override",
        }),
      );

      const decoded = readFileJson();
      const nudges = decoded.items.filter(
        (i) => i.type === "nudge" && i.source === "slack",
      );
      expect(nudges).toHaveLength(1);
      expect(nudges[0]!.author).toBe("assistant");
      expect(nudges[0]!.title).toBe("Assistant override");
    });

    test("platform nudge over an existing assistant nudge is a no-op", async () => {
      await appendFeedItem(
        makeItem({
          id: "assistant-nudge",
          type: "nudge",
          source: "slack",
          author: "assistant",
          title: "Assistant original",
        }),
      );
      await appendFeedItem(
        makeItem({
          id: "platform-nudge",
          type: "nudge",
          source: "slack",
          author: "platform",
          title: "Stale platform baseline",
        }),
      );

      const decoded = readFileJson();
      const nudges = decoded.items.filter(
        (i) => i.type === "nudge" && i.source === "slack",
      );
      expect(nudges).toHaveLength(1);
      expect(nudges[0]!.author).toBe("assistant");
      expect(nudges[0]!.title).toBe("Assistant original");
    });

    test("action without expiresAt is persisted with no auto-fade", async () => {
      // Action items are the feed's activity log — they must persist
      // until the user dismisses them. The writer used to fill in a
      // 24h default expiresAt; that behavior is intentionally gone.
      await appendFeedItem(
        makeItem({
          id: "action-1",
          type: "action",
          createdAt: "2026-04-14T12:00:00.000Z",
        }),
      );
      const decoded = readFileJson();
      expect(decoded.items).toHaveLength(1);
      expect(decoded.items[0]!.expiresAt).toBeUndefined();
    });

    test("action with an explicit expiresAt is left untouched", async () => {
      const explicit = "2026-04-15T00:00:00.000Z";
      await appendFeedItem(
        makeItem({
          id: "action-2",
          type: "action",
          expiresAt: explicit,
          createdAt: "2026-04-14T12:00:00.000Z",
        }),
      );
      const decoded = readFileJson();
      expect(decoded.items[0]!.expiresAt).toBe(explicit);
    });

    test("action with same id updates the existing entry in place", async () => {
      // Deterministic-dedup callers (emit-feed-event.ts dedupKey)
      // emit the same id on repeat signals; the writer must refresh
      // the existing entry rather than append a duplicate, otherwise
      // the same event would show up N times until the per-source
      // cap trimmed it.
      await appendFeedItem(
        makeItem({
          id: "emit:gmail:unread-msg-42",
          type: "action",
          source: "gmail",
          title: "Unread from Alice",
          createdAt: "2026-04-14T10:00:00.000Z",
        }),
      );
      await appendFeedItem(
        makeItem({
          id: "emit:gmail:unread-msg-42",
          type: "action",
          source: "gmail",
          title: "Unread from Alice (refreshed)",
          createdAt: "2026-04-14T12:00:00.000Z",
        }),
      );

      const decoded = readFileJson();
      const matching = decoded.items.filter(
        (i) => i.id === "emit:gmail:unread-msg-42",
      );
      expect(matching).toHaveLength(1);
      expect(matching[0]!.title).toBe("Unread from Alice (refreshed)");
    });

    test("multiple actions with the same (type, source) all persist", async () => {
      // Actions must not collapse onto each other by (type, source) —
      // each append is a distinct entry in the activity log.
      await appendFeedItem(
        makeItem({
          id: "action-a",
          type: "action",
          source: "gmail",
          title: "Acted A",
          createdAt: "2026-04-14T10:00:00.000Z",
        }),
      );
      await appendFeedItem(
        makeItem({
          id: "action-b",
          type: "action",
          source: "gmail",
          title: "Acted B",
          createdAt: "2026-04-14T11:00:00.000Z",
        }),
      );
      await appendFeedItem(
        makeItem({
          id: "action-c",
          type: "action",
          source: "gmail",
          title: "Acted C",
          createdAt: "2026-04-14T12:00:00.000Z",
        }),
      );

      const decoded = readFileJson();
      const gmailActions = decoded.items.filter(
        (i) => i.type === "action" && i.source === "gmail",
      );
      expect(gmailActions).toHaveLength(3);
      const ids = new Set(gmailActions.map((i) => i.id));
      expect(ids).toEqual(new Set(["action-a", "action-b", "action-c"]));
    });

    test("per-source action cap keeps only the N most recent per source", async () => {
      // Append MAX+5 actions for gmail, interleaved with a handful of
      // slack actions and a digest. Cap must apply only to the
      // overflowing source.
      const overflow = MAX_ACTIONS_PER_SOURCE + 5;
      for (let i = 0; i < overflow; i++) {
        await appendFeedItem(
          makeItem({
            id: `gmail-${i}`,
            type: "action",
            source: "gmail",
            title: `Gmail action ${i}`,
            createdAt: new Date(
              Date.parse("2026-04-14T00:00:00.000Z") + i * 60_000,
            ).toISOString(),
          }),
        );
      }
      await appendFeedItem(
        makeItem({
          id: "slack-1",
          type: "action",
          source: "slack",
          title: "Slack action",
          createdAt: "2026-04-14T12:00:00.000Z",
        }),
      );
      await appendFeedItem(
        makeItem({
          id: "digest-1",
          type: "digest",
          source: "gmail",
          title: "Gmail digest",
          createdAt: "2026-04-14T12:01:00.000Z",
        }),
      );

      const decoded = readFileJson();
      const gmailActions = decoded.items.filter(
        (i) => i.type === "action" && i.source === "gmail",
      );
      expect(gmailActions).toHaveLength(MAX_ACTIONS_PER_SOURCE);

      // The kept ids are the MAX most recent by createdAt — i.e. the
      // final MAX entries of the 0..overflow-1 sequence.
      const keptIds = new Set(gmailActions.map((i) => i.id));
      for (let i = overflow - MAX_ACTIONS_PER_SOURCE; i < overflow; i++) {
        expect(keptIds.has(`gmail-${i}`)).toBe(true);
      }
      for (let i = 0; i < overflow - MAX_ACTIONS_PER_SOURCE; i++) {
        expect(keptIds.has(`gmail-${i}`)).toBe(false);
      }

      // Slack is under the cap and the digest is a different type —
      // both untouched by the prune.
      expect(decoded.items.filter((i) => i.id === "slack-1")).toHaveLength(1);
      expect(decoded.items.filter((i) => i.type === "digest")).toHaveLength(1);
    });

    test("action items without a source are not subject to the cap", async () => {
      const n = MAX_ACTIONS_PER_SOURCE + 3;
      for (let i = 0; i < n; i++) {
        await appendFeedItem(
          makeItem({
            id: `sourceless-${i}`,
            type: "action",
            title: `Sourceless ${i}`,
            createdAt: new Date(
              Date.parse("2026-04-14T00:00:00.000Z") + i * 60_000,
            ).toISOString(),
          }),
        );
      }
      const decoded = readFileJson();
      const sourceless = decoded.items.filter(
        (i) => i.type === "action" && i.source === undefined,
      );
      expect(sourceless).toHaveLength(n);
    });

    test("thread updates replace the existing thread with the same id in place", async () => {
      await appendFeedItem(
        makeItem({
          id: "thread-A",
          type: "thread",
          title: "Thread v1",
          priority: 80,
          createdAt: "2026-04-14T12:00:00.000Z",
        }),
      );
      await appendFeedItem(
        makeItem({
          id: "thread-B",
          type: "thread",
          title: "Other thread",
          priority: 60,
          createdAt: "2026-04-14T11:00:00.000Z",
        }),
      );
      await appendFeedItem(
        makeItem({
          id: "thread-A",
          type: "thread",
          title: "Thread v2 updated",
          priority: 80,
          createdAt: "2026-04-14T12:00:00.000Z",
        }),
      );

      const decoded = readFileJson();
      expect(decoded.items).toHaveLength(2);
      const threadA = decoded.items.find((i) => i.id === "thread-A");
      expect(threadA?.title).toBe("Thread v2 updated");
    });

    test("items sort by priority desc then createdAt desc", async () => {
      await appendFeedItem(
        makeItem({
          id: "low",
          priority: 10,
          createdAt: "2026-04-14T12:00:00.000Z",
        }),
      );
      await appendFeedItem(
        makeItem({
          id: "high-old",
          priority: 90,
          createdAt: "2026-04-14T10:00:00.000Z",
        }),
      );
      await appendFeedItem(
        makeItem({
          id: "high-new",
          priority: 90,
          createdAt: "2026-04-14T11:00:00.000Z",
        }),
      );

      const decoded = readFileJson();
      expect(decoded.items.map((i) => i.id)).toEqual([
        "high-new",
        "high-old",
        "low",
      ]);
    });
  });

  describe("patchFeedItemStatus", () => {
    test("updates the status field on an existing item", async () => {
      await appendFeedItem(
        makeItem({
          id: "item-1",
          type: "nudge",
          title: "Original",
        }),
      );

      const result = await patchFeedItemStatus("item-1", "seen");
      expect(result).not.toBeNull();
      expect(result!.id).toBe("item-1");
      expect(result!.status).toBe("seen");
      // Title / other fields are preserved.
      expect(result!.title).toBe("Original");

      const decoded = readFileJson();
      expect(decoded.items[0]!.status).toBe("seen");
      expect(decoded.items[0]!.title).toBe("Original");
    });

    test("returns null for an unknown id", async () => {
      await appendFeedItem(makeItem({ id: "known", type: "nudge" }));
      const result = await patchFeedItemStatus("unknown", "seen");
      expect(result).toBeNull();
    });

    test("returns null when the underlying writeFileSync throws", async () => {
      // Seed the feed with an existing item on disk so the patch path
      // finds a match and would otherwise resolve with the mutated item.
      await appendFeedItem(
        makeItem({
          id: "fail-item",
          type: "nudge",
          title: "Pre-fail title",
        }),
      );

      // Force the next writeFileSync against the home-feed path to
      // throw so `runWrite()` sets `wrote = false`. Other writes (e.g.
      // to unrelated paths) are passed through untouched.
      const feedPath = getHomeFeedPath();
      const originalWrite = fs.writeFileSync;
      const spy = spyOn(fs, "writeFileSync").mockImplementation(((
        path: fs.PathOrFileDescriptor,
        data: string | NodeJS.ArrayBufferView,
        options?: fs.WriteFileOptions,
      ) => {
        if (typeof path === "string" && path === feedPath) {
          throw new Error("Simulated write failure");
        }
        return originalWrite(path, data, options);
      }) as typeof fs.writeFileSync);

      try {
        const result = await patchFeedItemStatus("fail-item", "seen");
        // Core assertion: the caller must NOT observe a "success" return
        // value when the write did not actually land.
        expect(result).toBeNull();

        // And the on-disk file should still show the pre-patch state.
        const decoded = readFileJson();
        expect(decoded.items[0]!.status).toBe("new");
        expect(decoded.items[0]!.title).toBe("Pre-fail title");
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe("concurrency", () => {
    test("10 concurrent appends of items with distinct (type,source) pairs all land", async () => {
      const items = Array.from({ length: 10 }, (_, i) =>
        makeItem({
          id: `distinct-${i}`,
          type: "nudge",
          // No source → no (type,source) dedupe at all; every item
          // lands as-is. This is the purest concurrent-append test.
          title: `Item ${i}`,
          createdAt: new Date(
            Date.parse("2026-04-14T12:00:00.000Z") + i * 1000,
          ).toISOString(),
        }),
      );

      await Promise.all(items.map((i) => appendFeedItem(i)));

      const decoded = readFileJson();
      expect(decoded.items).toHaveLength(10);
      const ids = new Set(decoded.items.map((i) => i.id));
      for (const item of items) {
        expect(ids.has(item.id)).toBe(true);
      }
    });
  });

  describe("SSE publish", () => {
    test("publishes home_feed_updated with correct newItemCount", async () => {
      await appendFeedItem(
        makeItem({
          id: "new-1",
          type: "nudge",
          status: "new",
        }),
      );
      await appendFeedItem(
        makeItem({
          id: "new-2",
          type: "nudge",
          status: "new",
          createdAt: "2026-04-14T12:00:01.000Z",
        }),
      );
      await appendFeedItem(
        makeItem({
          id: "seen-1",
          type: "nudge",
          status: "seen",
          createdAt: "2026-04-14T12:00:02.000Z",
        }),
      );

      expect(publishSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
      // Inspect the LAST publish — it reflects the final on-disk state.
      const lastCall = publishSpy.mock.calls[publishSpy.mock.calls.length - 1]!;
      const event = lastCall[0] as {
        assistantId: string;
        message: {
          type: string;
          updatedAt: string;
          newItemCount: number;
        };
      };
      expect(event.assistantId).toBe(DAEMON_INTERNAL_ASSISTANT_ID);
      expect(event.message.type).toBe("home_feed_updated");
      expect(event.message.newItemCount).toBe(2);
      expect(Number.isNaN(Date.parse(event.message.updatedAt))).toBe(false);
    });

    test("patching to seen decrements newItemCount in the SSE event", async () => {
      await appendFeedItem(
        makeItem({
          id: "x",
          type: "nudge",
          status: "new",
        }),
      );
      publishSpy.mockClear();

      await patchFeedItemStatus("x", "seen");

      expect(publishSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
      const lastCall = publishSpy.mock.calls[publishSpy.mock.calls.length - 1]!;
      const event = lastCall[0] as {
        message: { type: string; newItemCount: number };
      };
      expect(event.message.type).toBe("home_feed_updated");
      expect(event.message.newItemCount).toBe(0);
    });
  });
});
