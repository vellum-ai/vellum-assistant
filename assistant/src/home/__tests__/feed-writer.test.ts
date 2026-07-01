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
  broadcastMessage: async () => {},
}));

// Dynamic import so the module resolves after the mock above is in
// place. Bun's `mock.module` needs to run before the real import is
// evaluated for the mock to take effect.
const {
  HOME_FEED_FILENAME,
  HOME_FEED_VERSION,
  appendFeedItem,
  bulkSetFeedItemStatus,
  clearAllConversationIds,
  getHomeFeedPath,
  patchFeedItemStatus,
  readHomeFeed,
  stripConversationIds,
} = await import("../feed-writer.js");

type FeedItemStatus = "new" | "seen" | "acted_on" | "dismissed";

interface TestFeedItem {
  id: string;
  type: "notification";
  priority: number;
  title: string;
  summary: string;
  timestamp: string;
  status: FeedItemStatus;
  expiresAt?: string;
  conversationId?: string;
  createdAt: string;
}

function makeItem(
  overrides: Partial<TestFeedItem> & { id: string },
): TestFeedItem {
  return {
    type: "notification",
    priority: 50,
    title: "Test",
    summary: "Test summary",
    timestamp: "2026-04-14T12:00:00.000Z",
    status: "new",
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
    test("missing file returns an empty v2 HomeFeedFile", () => {
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
        version: 2,
        updatedAt: "2026-04-14T12:00:00.000Z",
        items: [
          makeItem({
            id: "expired",
            expiresAt: past,
          }),
          makeItem({
            id: "live",
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

    test("v1 file (legacy schema) fails Zod validation and falls back to empty", () => {
      // Defensive: if the workspace migration has not yet run (e.g. on
      // first daemon boot before migrations land, or a corrupted
      // migration checkpoint), the writer's read path must degrade
      // gracefully rather than throwing.
      mkdirSync(join(workspaceDir, "data"), { recursive: true });
      const v1File = {
        version: 1,
        updatedAt: "2026-04-14T12:00:00.000Z",
        items: [
          {
            id: "legacy",
            type: "nudge",
            priority: 50,
            title: "Legacy",
            summary: "Legacy summary",
            source: "gmail",
            author: "platform",
            timestamp: "2026-04-14T12:00:00.000Z",
            status: "new",
            createdAt: "2026-04-14T12:00:00.000Z",
          },
        ],
      };
      writeFileSync(
        getHomeFeedPath(),
        JSON.stringify(v1File, null, 2),
        "utf-8",
      );

      const feed = readHomeFeed();
      expect(feed.items).toEqual([]);
    });
  });

  describe("appendFeedItem", () => {
    test("appends a single notification to disk as v2", async () => {
      await appendFeedItem(
        makeItem({
          id: "notif-1",
          title: "New email",
          summary: "You have a new email",
        }),
      );
      const decoded = readFileJson();
      expect(decoded.version).toBe(2);
      expect(decoded.items).toHaveLength(1);
      expect(decoded.items[0]!.id).toBe("notif-1");
      expect(decoded.items[0]!.type).toBe("notification");
      expect(decoded.items[0]!.title).toBe("New email");
    });

    test("incoming item with the same id replaces the existing entry in place", async () => {
      // The v2 merge rule: same-id replaces (preserving array
      // position); otherwise append. Older entries with the same id
      // must NOT linger in the list as duplicates.
      await appendFeedItem(
        makeItem({
          id: "dup",
          title: "Original title",
          createdAt: "2026-04-14T10:00:00.000Z",
        }),
      );
      await appendFeedItem(
        makeItem({
          id: "other",
          title: "Other entry",
          createdAt: "2026-04-14T11:00:00.000Z",
        }),
      );
      await appendFeedItem(
        makeItem({
          id: "dup",
          title: "Refreshed title",
          createdAt: "2026-04-14T12:00:00.000Z",
        }),
      );

      const decoded = readFileJson();
      const matching = decoded.items.filter((i) => i.id === "dup");
      expect(matching).toHaveLength(1);
      expect(matching[0]!.title).toBe("Refreshed title");
      expect(decoded.items.find((i) => i.id === "other")).toBeDefined();
    });

    test("distinct ids all persist (no implicit dedup beyond same-id)", async () => {
      await appendFeedItem(
        makeItem({
          id: "a",
          title: "First",
          createdAt: "2026-04-14T10:00:00.000Z",
        }),
      );
      await appendFeedItem(
        makeItem({
          id: "b",
          title: "Second",
          createdAt: "2026-04-14T11:00:00.000Z",
        }),
      );
      await appendFeedItem(
        makeItem({
          id: "c",
          title: "Third",
          createdAt: "2026-04-14T12:00:00.000Z",
        }),
      );

      const decoded = readFileJson();
      expect(decoded.items).toHaveLength(3);
      const ids = new Set(decoded.items.map((i) => i.id));
      expect(ids).toEqual(new Set(["a", "b", "c"]));
    });

    test("item without expiresAt is persisted as-is (no auto-fade)", async () => {
      await appendFeedItem(
        makeItem({
          id: "no-expiry",
          createdAt: "2026-04-14T12:00:00.000Z",
        }),
      );
      const decoded = readFileJson();
      expect(decoded.items).toHaveLength(1);
      expect(decoded.items[0]!.expiresAt).toBeUndefined();
    });

    test("explicit expiresAt is left untouched", async () => {
      const explicit = "2026-04-15T00:00:00.000Z";
      await appendFeedItem(
        makeItem({
          id: "with-expiry",
          expiresAt: explicit,
          createdAt: "2026-04-14T12:00:00.000Z",
        }),
      );
      const decoded = readFileJson();
      expect(decoded.items[0]!.expiresAt).toBe(explicit);
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
      await appendFeedItem(makeItem({ id: "known" }));
      const result = await patchFeedItemStatus("unknown", "seen");
      expect(result).toBeNull();
    });

    test("returns null when the underlying writeFileSync throws", async () => {
      // Seed the feed with an existing item on disk so the patch path
      // finds a match and would otherwise resolve with the mutated item.
      await appendFeedItem(
        makeItem({
          id: "fail-item",
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
    test("10 concurrent appends with distinct ids all land", async () => {
      const items = Array.from({ length: 10 }, (_, i) =>
        makeItem({
          id: `distinct-${i}`,
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

  describe("stripConversationIds", () => {
    test("removes conversationId from matching items and leaves others untouched", async () => {
      await appendFeedItem(
        makeItem({
          id: "item-a",
          title: "Linked",
          conversationId: "conv-123",
        }),
      );
      await appendFeedItem(
        makeItem({
          id: "item-b",
          title: "Other conv",
          conversationId: "conv-456",
          createdAt: "2026-04-14T12:00:01.000Z",
        }),
      );
      await appendFeedItem(
        makeItem({
          id: "item-c",
          title: "No conv",
          createdAt: "2026-04-14T12:00:02.000Z",
        }),
      );

      await stripConversationIds("conv-123");

      const decoded = readFileJson();
      const itemA = decoded.items.find((i) => i.id === "item-a")!;
      const itemB = decoded.items.find((i) => i.id === "item-b")!;
      const itemC = decoded.items.find((i) => i.id === "item-c")!;

      expect(itemA.conversationId).toBeUndefined();
      expect(itemB.conversationId).toBe("conv-456");
      expect(itemC.conversationId).toBeUndefined();
    });

    test("returns the count of items modified", async () => {
      await appendFeedItem(
        makeItem({
          id: "m1",
          conversationId: "conv-abc",
        }),
      );
      await appendFeedItem(
        makeItem({
          id: "m2",
          conversationId: "conv-abc",
          createdAt: "2026-04-14T12:00:01.000Z",
        }),
      );
      await appendFeedItem(
        makeItem({
          id: "m3",
          conversationId: "conv-other",
          createdAt: "2026-04-14T12:00:02.000Z",
        }),
      );

      const count = await stripConversationIds("conv-abc");
      expect(count).toBe(2);
    });

    test("returns 0 when no items match", async () => {
      await appendFeedItem(
        makeItem({
          id: "no-match",
          conversationId: "conv-xyz",
        }),
      );

      const count = await stripConversationIds("conv-nonexistent");
      expect(count).toBe(0);
    });

    test("coalesces with pending appends correctly", async () => {
      // Fire an append and a strip concurrently — both should land in
      // the same coalesced write cycle.
      const appendPromise = appendFeedItem(
        makeItem({
          id: "coalesce-item",
          conversationId: "conv-coalesce",
        }),
      );
      const stripPromise = stripConversationIds("conv-coalesce");

      await Promise.all([appendPromise, stripPromise]);

      const decoded = readFileJson();
      const item = decoded.items.find((i) => i.id === "coalesce-item")!;
      // The append lands first, then the strip runs — conversationId
      // should be gone.
      expect(item).toBeDefined();
      expect(item.conversationId).toBeUndefined();
    });

    test("items retain all other fields after strip", async () => {
      await appendFeedItem(
        makeItem({
          id: "retain-fields",
          title: "Keep me",
          summary: "Important summary",
          conversationId: "conv-strip",
          priority: 75,
          status: "seen",
        }),
      );

      await stripConversationIds("conv-strip");

      const decoded = readFileJson();
      const item = decoded.items.find((i) => i.id === "retain-fields")!;
      expect(item.conversationId).toBeUndefined();
      expect(item.id).toBe("retain-fields");
      expect(item.title).toBe("Keep me");
      expect(item.summary).toBe("Important summary");
      expect(item.priority).toBe(75);
      expect(item.status).toBe("seen");
      expect(item.type).toBe("notification");
    });
  });

  describe("clearAllConversationIds", () => {
    test("strips conversationId from all items that have one", async () => {
      await appendFeedItem(
        makeItem({
          id: "all-1",
          conversationId: "conv-aaa",
        }),
      );
      await appendFeedItem(
        makeItem({
          id: "all-2",
          conversationId: "conv-bbb",
          createdAt: "2026-04-14T12:00:01.000Z",
        }),
      );
      await appendFeedItem(
        makeItem({
          id: "all-3",
          title: "No conv link",
          createdAt: "2026-04-14T12:00:02.000Z",
        }),
      );

      const count = await clearAllConversationIds();
      expect(count).toBe(2);

      const decoded = readFileJson();
      for (const item of decoded.items) {
        expect(item.conversationId).toBeUndefined();
      }
      // All three items still exist.
      expect(decoded.items).toHaveLength(3);
    });
  });

  describe("bulkSetFeedItemStatus", () => {
    test("flips every new item to seen, leaves other statuses alone", async () => {
      await appendFeedItem(makeItem({ id: "n1", status: "new" }));
      await appendFeedItem(
        makeItem({
          id: "n2",
          status: "new",
          createdAt: "2026-04-14T12:00:01.000Z",
        }),
      );
      await appendFeedItem(
        makeItem({
          id: "s1",
          status: "seen",
          createdAt: "2026-04-14T12:00:02.000Z",
        }),
      );
      await appendFeedItem(
        makeItem({
          id: "a1",
          status: "acted_on",
          createdAt: "2026-04-14T12:00:03.000Z",
        }),
      );

      const count = await bulkSetFeedItemStatus(["new"], "seen");
      expect(count).toBe(2);

      const decoded = readFileJson();
      const byId = new Map(decoded.items.map((i) => [i.id, i]));
      expect(byId.get("n1")!.status).toBe("seen");
      expect(byId.get("n2")!.status).toBe("seen");
      expect(byId.get("s1")!.status).toBe("seen");
      expect(byId.get("a1")!.status).toBe("acted_on");
    });

    test("returns 0 when nothing matches", async () => {
      await appendFeedItem(makeItem({ id: "s1", status: "seen" }));
      await appendFeedItem(
        makeItem({
          id: "s2",
          status: "seen",
          createdAt: "2026-04-14T12:00:01.000Z",
        }),
      );
      await appendFeedItem(
        makeItem({
          id: "s3",
          status: "seen",
          createdAt: "2026-04-14T12:00:02.000Z",
        }),
      );
      publishSpy.mockClear();

      const count = await bulkSetFeedItemStatus(["new"], "seen");
      expect(count).toBe(0);
      // The writer still emits a publish for the empty-pass cycle,
      // matching the strip/patch pattern.
      expect(publishSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
    });

    test("skips items already at target status", async () => {
      await appendFeedItem(makeItem({ id: "n1", status: "new" }));
      await appendFeedItem(
        makeItem({
          id: "s1",
          status: "seen",
          createdAt: "2026-04-14T12:00:01.000Z",
        }),
      );

      const count = await bulkSetFeedItemStatus(["new", "seen"], "seen");
      expect(count).toBe(1);

      const decoded = readFileJson();
      for (const item of decoded.items) {
        expect(item.status).toBe("seen");
      }
    });

    test("clear-all flips new + seen + acted_on to dismissed and leaves dismissed alone", async () => {
      await appendFeedItem(makeItem({ id: "n1", status: "new" }));
      await appendFeedItem(
        makeItem({
          id: "s1",
          status: "seen",
          createdAt: "2026-04-14T12:00:01.000Z",
        }),
      );
      await appendFeedItem(
        makeItem({
          id: "a1",
          status: "acted_on",
          createdAt: "2026-04-14T12:00:02.000Z",
        }),
      );
      await appendFeedItem(
        makeItem({
          id: "d1",
          status: "dismissed",
          createdAt: "2026-04-14T12:00:03.000Z",
        }),
      );

      const count = await bulkSetFeedItemStatus(
        ["new", "seen", "acted_on"],
        "dismissed",
      );
      expect(count).toBe(3);

      const decoded = readFileJson();
      for (const item of decoded.items) {
        expect(item.status).toBe("dismissed");
      }
    });

    test("ids scope limits bulk update to matching item ids only", async () => {
      await appendFeedItem(makeItem({ id: "n1", status: "new" }));
      await appendFeedItem(
        makeItem({
          id: "n2",
          status: "new",
          createdAt: "2026-04-14T12:00:01.000Z",
        }),
      );
      await appendFeedItem(
        makeItem({
          id: "n3",
          status: "new",
          createdAt: "2026-04-14T12:00:02.000Z",
        }),
      );

      const count = await bulkSetFeedItemStatus(
        ["new"],
        "seen",
        ["n1", "n3"],
      );
      expect(count).toBe(2);

      const decoded = readFileJson();
      const byId = new Map(decoded.items.map((i) => [i.id, i.status]));
      expect(byId.get("n1")).toBe("seen");
      expect(byId.get("n2")).toBe("new");
      expect(byId.get("n3")).toBe("seen");
    });

    test("ids scope with no matching ids returns 0", async () => {
      await appendFeedItem(makeItem({ id: "n1", status: "new" }));

      const count = await bulkSetFeedItemStatus(["new"], "seen", ["nonexistent"]);
      expect(count).toBe(0);

      const decoded = readFileJson();
      expect(decoded.items[0]!.status).toBe("new");
    });

    test("returns -1 when the underlying writeFileSync throws", async () => {
      await appendFeedItem(
        makeItem({
          id: "fail-bulk",
          status: "new",
        }),
      );

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
        const count = await bulkSetFeedItemStatus(["new"], "seen");
        expect(count).toBe(-1);

        const decoded = readFileJson();
        expect(decoded.items[0]!.status).toBe("new");
      } finally {
        spy.mockRestore();
      }
    });

    test("SSE home_feed_updated fires with correct post-flip newItemCount", async () => {
      await appendFeedItem(makeItem({ id: "n1", status: "new" }));
      await appendFeedItem(
        makeItem({
          id: "n2",
          status: "new",
          createdAt: "2026-04-14T12:00:01.000Z",
        }),
      );
      await appendFeedItem(
        makeItem({
          id: "s1",
          status: "seen",
          createdAt: "2026-04-14T12:00:02.000Z",
        }),
      );
      publishSpy.mockClear();

      await bulkSetFeedItemStatus(["new"], "seen");

      expect(publishSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
      const lastCall = publishSpy.mock.calls[publishSpy.mock.calls.length - 1]!;
      const event = lastCall[0] as {
        message: { type: string; newItemCount: number };
      };
      expect(event.message.type).toBe("home_feed_updated");
      expect(event.message.newItemCount).toBe(0);
    });

    test("coalesces with a concurrent append: late-appended new item is also flipped", async () => {
      await appendFeedItem(makeItem({ id: "existing", status: "new" }));

      // Both calls push to their pending arrays synchronously before
      // the async scheduleWrite runs, so they land in the same
      // runWrite cycle. runWrite applies appends before bulk-status,
      // so the late item is observed as `new` by the bulk pass and
      // gets flipped.
      const appendPromise = appendFeedItem(
        makeItem({
          id: "late",
          status: "new",
          createdAt: "2026-04-14T12:00:05.000Z",
        }),
      );
      const bulkPromise = bulkSetFeedItemStatus(["new"], "seen");

      const [_, count] = await Promise.all([appendPromise, bulkPromise]);
      expect(count).toBe(2);

      const decoded = readFileJson();
      const byId = new Map(decoded.items.map((i) => [i.id, i]));
      expect(byId.get("existing")!.status).toBe("seen");
      expect(byId.get("late")!.status).toBe("seen");
    });
  });

  describe("SSE publish", () => {
    test("publishes home_feed_updated with correct newItemCount", async () => {
      await appendFeedItem(
        makeItem({
          id: "new-1",
          status: "new",
        }),
      );
      await appendFeedItem(
        makeItem({
          id: "new-2",
          status: "new",
          createdAt: "2026-04-14T12:00:01.000Z",
        }),
      );
      await appendFeedItem(
        makeItem({
          id: "seen-1",
          status: "seen",
          createdAt: "2026-04-14T12:00:02.000Z",
        }),
      );

      expect(publishSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
      // Inspect the LAST publish — it reflects the final on-disk state.
      const lastCall = publishSpy.mock.calls[publishSpy.mock.calls.length - 1]!;
      const event = lastCall[0] as {
        message: {
          type: string;
          updatedAt: string;
          newItemCount: number;
        };
      };
      expect(event.message.type).toBe("home_feed_updated");
      expect(event.message.newItemCount).toBe(2);
      expect(Number.isNaN(Date.parse(event.message.updatedAt))).toBe(false);
    });

    test("patching to seen decrements newItemCount in the SSE event", async () => {
      await appendFeedItem(
        makeItem({
          id: "x",
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
