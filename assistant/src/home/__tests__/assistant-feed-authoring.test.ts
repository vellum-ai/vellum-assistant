import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { FeedAction, FeedItem } from "../feed-types.js";

// ─── feed-writer mock ──────────────────────────────────────────────────
// We mock `appendFeedItem` at the module level so the helper under
// test delegates to the mock instead of hitting disk. The mock is
// installed before the dynamic import below so the helper module
// picks it up during resolution.
const appendFeedItemMock = mock<(item: FeedItem) => Promise<void>>(
  async () => {},
);

mock.module("../feed-writer.js", () => ({
  appendFeedItem: appendFeedItemMock,
}));

// Dynamic import — must run after `mock.module` above so the helper
// resolves against the mocked writer.
const { writeAssistantFeedItem } =
  await import("../assistant-feed-authoring.js");

beforeEach(() => {
  appendFeedItemMock.mockClear();
});

describe("writeAssistantFeedItem", () => {
  test("builds an assistant-authored FeedItem and delegates to appendFeedItem", async () => {
    const item = await writeAssistantFeedItem({
      type: "nudge",
      source: "gmail",
      title: "Urgent email from Alice",
      summary: "Alice is asking when the deck lands",
    });

    // Author is hard-coded to "assistant" — this is the whole point
    // of the helper (wins over platform for the same (type,source)).
    expect(item.author).toBe("assistant");
    // Non-empty UUID id was generated.
    expect(typeof item.id).toBe("string");
    expect(item.id.length).toBeGreaterThan(0);
    // Status defaults to "new".
    expect(item.status).toBe("new");
    // Semantic fields are passed through untouched.
    expect(item.type).toBe("nudge");
    expect(item.source).toBe("gmail");
    expect(item.title).toBe("Urgent email from Alice");
    expect(item.summary).toBe("Alice is asking when the deck lands");

    // Delegated to the writer exactly once with the constructed item.
    expect(appendFeedItemMock.mock.calls).toHaveLength(1);
    const [appended] = appendFeedItemMock.mock.calls[0]!;
    expect(appended).toBe(item);
  });

  test("defaults priority to 60 when not supplied", async () => {
    const item = await writeAssistantFeedItem({
      type: "digest",
      source: "slack",
      title: "Slack digest",
      summary: "3 threads need a reply",
    });

    expect(item.priority).toBe(60);
    expect(appendFeedItemMock.mock.calls).toHaveLength(1);
    expect(appendFeedItemMock.mock.calls[0]![0]!.priority).toBe(60);
  });

  test("passes an explicit priority through untouched", async () => {
    const item = await writeAssistantFeedItem({
      type: "nudge",
      source: "slack",
      title: "High-priority nudge",
      summary: "You should look at this",
      priority: 80,
    });

    expect(item.priority).toBe(80);
    expect(appendFeedItemMock.mock.calls[0]![0]!.priority).toBe(80);
  });

  test("populates createdAt and timestamp as ISO strings", async () => {
    const before = Date.now();
    const item = await writeAssistantFeedItem({
      type: "nudge",
      title: "Ping",
      summary: "Ping summary",
    });
    const after = Date.now();

    expect(typeof item.timestamp).toBe("string");
    expect(typeof item.createdAt).toBe("string");

    const timestampMs = Date.parse(item.timestamp);
    const createdAtMs = Date.parse(item.createdAt);
    expect(Number.isNaN(timestampMs)).toBe(false);
    expect(Number.isNaN(createdAtMs)).toBe(false);

    // Both are stamped at call time.
    expect(timestampMs).toBeGreaterThanOrEqual(before);
    expect(timestampMs).toBeLessThanOrEqual(after);
    expect(createdAtMs).toBeGreaterThanOrEqual(before);
    expect(createdAtMs).toBeLessThanOrEqual(after);
  });

  test("passes the actions array through untouched", async () => {
    const actions: FeedAction[] = [
      { id: "reply", label: "Reply", prompt: "Draft a reply to Alice" },
      { id: "snooze", label: "Snooze", prompt: "Snooze this for 1 hour" },
    ];

    const item = await writeAssistantFeedItem({
      type: "action",
      source: "gmail",
      title: "Alice needs a reply",
      summary: "Reply or snooze",
      actions,
    });

    expect(item.actions).toEqual(actions);
    // Delegated value is the same object the caller passed in.
    expect(appendFeedItemMock.mock.calls[0]![0]!.actions).toEqual(actions);
  });

  test("throws a Zod validation error when the constructed item violates the schema", async () => {
    // Plan calls for a "missing required fields → throws Zod error"
    // test. The underlying `feedItemSchema` uses `z.string()` (not
    // `.min(1)`) so an empty title technically parses, but an
    // out-of-range priority is a guaranteed schema violation and
    // exercises the same guardrail path: `feedItemSchema.parse()`
    // rejects the item, the helper rethrows, and `appendFeedItem` is
    // NEVER called.
    await expect(
      writeAssistantFeedItem({
        type: "nudge",
        title: "bad",
        summary: "also bad",
        priority: 150,
      }),
    ).rejects.toThrow();

    // And for the original "missing required field" intent from the
    // plan: force-omit `title` through a type cast and confirm the
    // schema still rejects (z.string() rejects `undefined`).
    await expect(
      writeAssistantFeedItem({
        type: "nudge",
        summary: "no title",
        // biome-ignore lint/suspicious/noExplicitAny: deliberately invalid
      } as any),
    ).rejects.toThrow();

    // The invalid calls must NOT have reached the writer.
    expect(appendFeedItemMock.mock.calls).toHaveLength(0);
  });
});
