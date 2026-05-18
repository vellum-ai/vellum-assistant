import { describe, expect, test } from "bun:test";

import { type FeedItem, feedItemSchema, parseFeedFile } from "../feed-types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW_ISO = "2026-04-14T12:00:00.000Z";

function minimalNotification(): Record<string, unknown> {
  return {
    id: "notif-1",
    type: "notification",
    priority: 50,
    title: "Follow up on the Figma file",
    summary: "You mentioned wanting to review the onboarding designs.",
    timestamp: NOW_ISO,
    createdAt: NOW_ISO,
  };
}

function notificationWithActions(): Record<string, unknown> {
  return {
    ...minimalNotification(),
    id: "notif-action-1",
    priority: 60,
    title: "Approve expense report",
    summary: "Pending since Tuesday",
    actions: [
      {
        id: "approve",
        label: "Approve",
        prompt: "Approve the expense report.",
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Valid minimal items
// ---------------------------------------------------------------------------

describe("feedItemSchema — valid minimal items", () => {
  test("valid minimal notification parses successfully", () => {
    const parsed = feedItemSchema.parse(minimalNotification());
    expect(parsed.type).toBe("notification");
    // `status` defaults to "new" when absent.
    expect(parsed.status).toBe("new");
  });

  test("notification with actions array parses and preserves the prompt", () => {
    const parsed = feedItemSchema.parse(notificationWithActions());
    expect(parsed.type).toBe("notification");
    expect(parsed.actions).toHaveLength(1);
    expect(parsed.actions?.[0]?.prompt).toBe("Approve the expense report.");
  });

  test("status defaults to 'new' when omitted", () => {
    const parsed = feedItemSchema.parse(minimalNotification());
    expect(parsed.status).toBe("new");
  });

  test("explicit status value is preserved", () => {
    const parsed = feedItemSchema.parse({
      ...minimalNotification(),
      status: "seen",
    });
    expect(parsed.status).toBe("seen");
  });

  test("urgency, conversationId, expiresAt, detailPanel pass through", () => {
    const parsed = feedItemSchema.parse({
      ...minimalNotification(),
      urgency: "high",
      conversationId: "conv-abc",
      expiresAt: "2026-04-15T00:00:00.000Z",
      detailPanel: { kind: "emailDraft" },
    });
    expect(parsed.urgency).toBe("high");
    expect(parsed.conversationId).toBe("conv-abc");
    expect(parsed.expiresAt).toBe("2026-04-15T00:00:00.000Z");
    expect(parsed.detailPanel?.kind).toBe("emailDraft");
  });

  test("category field passes through when present", () => {
    for (const cat of [
      "security",
      "scheduling",
      "background",
      "email",
      "system",
    ] as const) {
      const parsed = feedItemSchema.parse({
        ...minimalNotification(),
        category: cat,
      });
      expect(parsed.category).toBe(cat);
    }
  });

  test("metadata field passes through when present", () => {
    const parsed = feedItemSchema.parse({
      ...minimalNotification(),
      metadata: { subject: "Hello", count: 3, nested: { ok: true } },
    });
    expect(parsed.metadata).toEqual({
      subject: "Hello",
      count: 3,
      nested: { ok: true },
    });
  });

  test("items without category or metadata still parse (backward compat)", () => {
    const parsed = feedItemSchema.parse(minimalNotification());
    expect(parsed.category).toBeUndefined();
    expect(parsed.metadata).toBeUndefined();
  });

  test("noteworthy field passes through when present", () => {
    const parsed = feedItemSchema.parse({
      ...minimalNotification(),
      noteworthy: true,
    });
    expect(parsed.noteworthy).toBe(true);
  });

  test("items without noteworthy field still parse (backward compat)", () => {
    const parsed = feedItemSchema.parse(minimalNotification());
    expect(parsed.noteworthy).toBeUndefined();
  });

  test("title is optional and may be omitted", () => {
    const { title: _omitted, ...rest } = minimalNotification();
    const parsed = feedItemSchema.parse(rest);
    expect(parsed.title).toBeUndefined();
    expect(parsed.summary).toBe(
      "You mentioned wanting to review the onboarding designs.",
    );
  });
});

// ---------------------------------------------------------------------------
// Invalid priority values
// ---------------------------------------------------------------------------

describe("feedItemSchema — priority validation", () => {
  test("rejects priority -1", () => {
    expect(() =>
      feedItemSchema.parse({ ...minimalNotification(), priority: -1 }),
    ).toThrow();
  });

  test("rejects priority 101", () => {
    expect(() =>
      feedItemSchema.parse({ ...minimalNotification(), priority: 101 }),
    ).toThrow();
  });

  test("rejects priority as string '5'", () => {
    expect(() =>
      feedItemSchema.parse({ ...minimalNotification(), priority: "5" }),
    ).toThrow();
  });

  test("rejects non-integer priority (e.g. 50.5)", () => {
    expect(() =>
      feedItemSchema.parse({ ...minimalNotification(), priority: 50.5 }),
    ).toThrow();
  });

  test("accepts boundary values 0 and 100", () => {
    expect(() =>
      feedItemSchema.parse({ ...minimalNotification(), priority: 0 }),
    ).not.toThrow();
    expect(() =>
      feedItemSchema.parse({ ...minimalNotification(), priority: 100 }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Invalid enum fields
// ---------------------------------------------------------------------------

describe("feedItemSchema — enum validation", () => {
  test("rejects unknown `type`", () => {
    expect(() =>
      feedItemSchema.parse({ ...minimalNotification(), type: "banner" }),
    ).toThrow();
  });

  test("rejects legacy v1 `type` values (nudge/digest/action/thread)", () => {
    for (const legacy of ["nudge", "digest", "action", "thread"] as const) {
      expect(() =>
        feedItemSchema.parse({ ...minimalNotification(), type: legacy }),
      ).toThrow();
    }
  });

  test("rejects unknown `category`", () => {
    expect(() =>
      feedItemSchema.parse({ ...minimalNotification(), category: "weather" }),
    ).toThrow();
  });

  test("rejects unknown `status`", () => {
    expect(() =>
      feedItemSchema.parse({ ...minimalNotification(), status: "archived" }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// parseFeedFile
// ---------------------------------------------------------------------------

describe("parseFeedFile", () => {
  test("accepts empty file with version 2", () => {
    const parsed = parseFeedFile({
      version: 2,
      items: [],
      updatedAt: NOW_ISO,
    });
    expect(parsed.version).toBe(2);
    expect(parsed.items).toEqual([]);
    expect(parsed.updatedAt).toBe(NOW_ISO);
  });

  test("accepts file with multiple valid items", () => {
    const parsed = parseFeedFile({
      version: 2,
      items: [minimalNotification(), notificationWithActions()],
      updatedAt: NOW_ISO,
    });
    expect(parsed.items).toHaveLength(2);
    const types = parsed.items.map((i: FeedItem) => i.type);
    expect(types).toEqual(["notification", "notification"]);
  });

  test("throws on non-object input", () => {
    expect(() => parseFeedFile(null)).toThrow();
    expect(() => parseFeedFile(undefined)).toThrow();
    expect(() => parseFeedFile("not an object")).toThrow();
    expect(() => parseFeedFile(42)).toThrow();
  });

  test("throws on legacy v1 version", () => {
    expect(() =>
      parseFeedFile({ version: 1, items: [], updatedAt: NOW_ISO }),
    ).toThrow();
  });

  test("throws on unknown version", () => {
    expect(() =>
      parseFeedFile({ version: 99, items: [], updatedAt: NOW_ISO }),
    ).toThrow();
  });

  test("throws when an item in the file is invalid", () => {
    expect(() =>
      parseFeedFile({
        version: 2,
        items: [{ ...minimalNotification(), priority: 999 }],
        updatedAt: NOW_ISO,
      }),
    ).toThrow();
  });

  test("accepts a file with a noteworthy item", () => {
    const parsed = parseFeedFile({
      version: 2,
      items: [{ ...minimalNotification(), noteworthy: true }],
      updatedAt: NOW_ISO,
    });
    expect(parsed.items[0]?.noteworthy).toBe(true);
  });

  test("accepts a file whose items omit noteworthy (backward compat)", () => {
    const parsed = parseFeedFile({
      version: 2,
      items: [minimalNotification()],
      updatedAt: NOW_ISO,
    });
    expect(parsed.items[0]?.noteworthy).toBeUndefined();
  });
});
