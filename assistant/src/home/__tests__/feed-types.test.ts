import { describe, expect, test } from "bun:test";

import { type FeedItem, feedItemSchema, parseFeedFile } from "../feed-types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW_ISO = "2026-04-14T12:00:00.000Z";

function minimalNudge(): Record<string, unknown> {
  return {
    id: "nudge-1",
    type: "nudge",
    priority: 50,
    title: "Follow up on the Figma file",
    summary: "You mentioned wanting to review the onboarding designs.",
    timestamp: NOW_ISO,
    author: "assistant",
    createdAt: NOW_ISO,
  };
}

function minimalDigest(): Record<string, unknown> {
  return {
    id: "digest-gmail",
    type: "digest",
    priority: 40,
    title: "3 new emails",
    summary: "Since yesterday",
    source: "gmail",
    timestamp: NOW_ISO,
    author: "platform",
    createdAt: NOW_ISO,
  };
}

function minimalAction(): Record<string, unknown> {
  return {
    id: "action-1",
    type: "action",
    priority: 60,
    title: "Approve expense report",
    summary: "Pending since Tuesday",
    timestamp: NOW_ISO,
    author: "assistant",
    createdAt: NOW_ISO,
    actions: [
      {
        id: "approve",
        label: "Approve",
        prompt: "Approve the expense report.",
      },
    ],
  };
}

function minimalThread(): Record<string, unknown> {
  return {
    id: "thread-1",
    type: "thread",
    priority: 30,
    title: "Draft reply to Alice",
    summary: "Waiting on your input",
    timestamp: NOW_ISO,
    author: "assistant",
    createdAt: NOW_ISO,
  };
}

// ---------------------------------------------------------------------------
// Valid minimal items
// ---------------------------------------------------------------------------

describe("feedItemSchema — valid minimal items", () => {
  test("valid minimal nudge parses successfully", () => {
    const parsed = feedItemSchema.parse(minimalNudge());
    expect(parsed.type).toBe("nudge");
    // `status` defaults to "new" when absent.
    expect(parsed.status).toBe("new");
    expect(parsed.author).toBe("assistant");
  });

  test("valid minimal digest parses successfully", () => {
    const parsed = feedItemSchema.parse(minimalDigest());
    expect(parsed.type).toBe("digest");
    expect(parsed.source).toBe("gmail");
    expect(parsed.author).toBe("platform");
  });

  test("valid minimal action parses successfully", () => {
    const parsed = feedItemSchema.parse(minimalAction());
    expect(parsed.type).toBe("action");
    expect(parsed.actions).toHaveLength(1);
    expect(parsed.actions?.[0]?.prompt).toBe("Approve the expense report.");
  });

  test("valid minimal thread parses successfully", () => {
    const parsed = feedItemSchema.parse(minimalThread());
    expect(parsed.type).toBe("thread");
  });

  test("status defaults to 'new' when omitted", () => {
    const parsed = feedItemSchema.parse(minimalNudge());
    expect(parsed.status).toBe("new");
  });

  test("explicit status value is preserved", () => {
    const parsed = feedItemSchema.parse({ ...minimalNudge(), status: "seen" });
    expect(parsed.status).toBe("seen");
  });
});

// ---------------------------------------------------------------------------
// Invalid priority values
// ---------------------------------------------------------------------------

describe("feedItemSchema — priority validation", () => {
  test("rejects priority -1", () => {
    expect(() =>
      feedItemSchema.parse({ ...minimalNudge(), priority: -1 }),
    ).toThrow();
  });

  test("rejects priority 101", () => {
    expect(() =>
      feedItemSchema.parse({ ...minimalNudge(), priority: 101 }),
    ).toThrow();
  });

  test("rejects priority as string '5'", () => {
    expect(() =>
      feedItemSchema.parse({ ...minimalNudge(), priority: "5" }),
    ).toThrow();
  });

  test("rejects non-integer priority (e.g. 50.5)", () => {
    expect(() =>
      feedItemSchema.parse({ ...minimalNudge(), priority: 50.5 }),
    ).toThrow();
  });

  test("accepts boundary values 0 and 100", () => {
    expect(() =>
      feedItemSchema.parse({ ...minimalNudge(), priority: 0 }),
    ).not.toThrow();
    expect(() =>
      feedItemSchema.parse({ ...minimalNudge(), priority: 100 }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Invalid enum fields
// ---------------------------------------------------------------------------

describe("feedItemSchema — enum validation", () => {
  test("rejects unknown `type`", () => {
    expect(() =>
      feedItemSchema.parse({ ...minimalNudge(), type: "banner" }),
    ).toThrow();
  });

  test("rejects unknown `status`", () => {
    expect(() =>
      feedItemSchema.parse({ ...minimalNudge(), status: "archived" }),
    ).toThrow();
  });

  test("rejects unknown `source` (e.g. 'facebook')", () => {
    expect(() =>
      feedItemSchema.parse({ ...minimalNudge(), source: "facebook" }),
    ).toThrow();
  });

  test("rejects unknown `author`", () => {
    expect(() =>
      feedItemSchema.parse({ ...minimalNudge(), author: "user" }),
    ).toThrow();
  });

  test("allows omitted `source`", () => {
    const raw = minimalNudge();
    delete (raw as Record<string, unknown>).source;
    expect(() => feedItemSchema.parse(raw)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// minTimeAway validation
// ---------------------------------------------------------------------------

describe("feedItemSchema — minTimeAway validation", () => {
  test("accepts non-negative integer", () => {
    const parsed = feedItemSchema.parse({
      ...minimalNudge(),
      minTimeAway: 3600,
    });
    expect(parsed.minTimeAway).toBe(3600);
  });

  test("accepts 0", () => {
    expect(() =>
      feedItemSchema.parse({ ...minimalNudge(), minTimeAway: 0 }),
    ).not.toThrow();
  });

  test("rejects negative values", () => {
    expect(() =>
      feedItemSchema.parse({ ...minimalNudge(), minTimeAway: -1 }),
    ).toThrow();
  });

  test("rejects non-integer values", () => {
    expect(() =>
      feedItemSchema.parse({ ...minimalNudge(), minTimeAway: 1.5 }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// parseFeedFile
// ---------------------------------------------------------------------------

describe("parseFeedFile", () => {
  test("accepts empty file with version 1", () => {
    const parsed = parseFeedFile({
      version: 1,
      items: [],
      updatedAt: NOW_ISO,
    });
    expect(parsed.version).toBe(1);
    expect(parsed.items).toEqual([]);
    expect(parsed.updatedAt).toBe(NOW_ISO);
  });

  test("accepts file with multiple valid items", () => {
    const parsed = parseFeedFile({
      version: 1,
      items: [
        minimalNudge(),
        minimalDigest(),
        minimalAction(),
        minimalThread(),
      ],
      updatedAt: NOW_ISO,
    });
    expect(parsed.items).toHaveLength(4);
    const types = parsed.items.map((i: FeedItem) => i.type);
    expect(types).toEqual(["nudge", "digest", "action", "thread"]);
  });

  test("throws on non-object input", () => {
    expect(() => parseFeedFile(null)).toThrow();
    expect(() => parseFeedFile(undefined)).toThrow();
    expect(() => parseFeedFile("not an object")).toThrow();
    expect(() => parseFeedFile(42)).toThrow();
  });

  test("throws on wrong version", () => {
    expect(() =>
      parseFeedFile({ version: 2, items: [], updatedAt: NOW_ISO }),
    ).toThrow();
  });

  test("throws when an item in the file is invalid", () => {
    expect(() =>
      parseFeedFile({
        version: 1,
        items: [{ ...minimalNudge(), priority: 999 }],
        updatedAt: NOW_ISO,
      }),
    ).toThrow();
  });
});
