import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// ─── assistantEventHub mock ────────────────────────────────────────────
// The real feed-writer publishes `home_feed_updated` via the in-process
// event hub on every write; tests don't care about that side effect, so
// we stub the hub to an inert publisher. Must be in place before the
// first dynamic import of feed-writer.js so the module graph picks up
// the mock.
const publishSpy = mock<(event: unknown) => Promise<void>>(async () => {});

mock.module("../../runtime/assistant-event-hub.js", () => ({
  assistantEventHub: {
    publish: publishSpy,
    subscribe: () => () => {},
  },
}));

// Dynamic import so the mock above resolves before the real module is
// evaluated.
const { generateGmailDigest } = await import("../platform-gmail-digest.js");
const { getHomeFeedPath, readHomeFeed } = await import("../feed-writer.js");

// ─── tmpdir workspace lifecycle ────────────────────────────────────────

let workspaceDir: string;
let origWorkspaceDir: string | undefined;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "vellum-pgd-"));
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

// ─── Tests ─────────────────────────────────────────────────────────────

describe("generateGmailDigest", () => {
  test("returns null and does not write when count is 0", async () => {
    const result = await generateGmailDigest(
      new Date("2026-04-14T12:00:00.000Z"),
      async () => 0,
    );
    expect(result).toBeNull();

    // No file should have been written — readHomeFeed returns the
    // empty sentinel with the Unix-epoch updatedAt.
    const feed = readHomeFeed();
    expect(feed.items).toEqual([]);
    expect(feed.updatedAt).toBe(new Date(0).toISOString());
  });

  test("returns a digest FeedItem with the expected shape when count > 0", async () => {
    const now = new Date("2026-04-14T12:00:00.000Z");
    const result = await generateGmailDigest(now, async () => 7);

    expect(result).not.toBeNull();
    expect(result!.type).toBe("digest");
    expect(result!.source).toBe("gmail");
    expect(result!.author).toBe("platform");
    expect(result!.priority).toBe(40);
    expect(result!.minTimeAway).toBe(3600);
    expect(result!.status).toBe("new");
    expect(result!.title).toContain("7");
    expect(result!.timestamp).toBe(now.toISOString());
    expect(result!.createdAt).toBe(now.toISOString());
  });

  test("minTimeAway is exactly 3600 seconds (1 hour)", async () => {
    const result = await generateGmailDigest(
      new Date("2026-04-14T12:00:00.000Z"),
      async () => 1,
    );
    expect(result).not.toBeNull();
    expect(result!.minTimeAway).toBe(3600);
  });

  test("title uses singular form for count of 1, plural otherwise", async () => {
    const now = new Date("2026-04-14T12:00:00.000Z");

    const one = await generateGmailDigest(now, async () => 1);
    expect(one!.title).toBe("1 new email");

    const many = await generateGmailDigest(now, async () => 3);
    expect(many!.title).toBe("3 new emails");
  });

  test("returns null when count source throws", async () => {
    const result = await generateGmailDigest(
      new Date("2026-04-14T12:00:00.000Z"),
      async () => {
        throw new Error("boom");
      },
    );
    expect(result).toBeNull();

    const feed = readHomeFeed();
    expect(feed.items).toEqual([]);
  });

  test("writes the item to home-feed.json via appendFeedItem", async () => {
    const now = new Date("2026-04-14T12:00:00.000Z");
    const result = await generateGmailDigest(now, async () => 5);
    expect(result).not.toBeNull();

    const raw = readFileSync(getHomeFeedPath(), "utf-8");
    const file = JSON.parse(raw) as {
      items: Array<{
        id: string;
        type: string;
        source?: string;
        author: string;
        priority: number;
        title: string;
      }>;
    };

    expect(file.items.length).toBe(1);
    expect(file.items[0]).toMatchObject({
      id: result!.id,
      type: "digest",
      source: "gmail",
      author: "platform",
      priority: 40,
      title: "5 new emails",
    });
  });

  test("summary uses generic check-in copy on first-ever digest", async () => {
    const result = await generateGmailDigest(
      new Date("2026-04-14T12:00:00.000Z"),
      async () => 4,
    );
    expect(result).not.toBeNull();
    expect(result!.summary).toBe("Since your last check-in");
  });

  test("summary references the prior digest timestamp on subsequent call", async () => {
    const first = await generateGmailDigest(
      new Date("2026-04-14T14:32:00.000Z"),
      async () => 2,
    );
    expect(first).not.toBeNull();

    // Same-day follow-up → "Since h:mm AM/PM" pulled from the first
    // digest's timestamp (2:32 PM UTC rendered via en-US locale).
    const sameDay = await generateGmailDigest(
      new Date("2026-04-14T16:00:00.000Z"),
      async () => 5,
    );
    expect(sameDay).not.toBeNull();
    expect(sameDay!.summary).toMatch(/^Since \d{1,2}:\d{2}\s?(AM|PM)$/);
  });

  test("summary includes weekday when prior digest is on a different day", async () => {
    const first = await generateGmailDigest(
      new Date("2026-04-13T22:00:00.000Z"),
      async () => 1,
    );
    expect(first).not.toBeNull();

    const nextDay = await generateGmailDigest(
      new Date("2026-04-14T14:00:00.000Z"),
      async () => 3,
    );
    expect(nextDay).not.toBeNull();
    // Cross-day → "Since <Weekday> h:mm AM/PM" — weekday prefix set.
    expect(nextDay!.summary).toMatch(
      /^Since (Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d{1,2}:\d{2}\s?(AM|PM)$/,
    );
  });

  // Integration: exercise the writer's one-per-source rule. Two
  // successive generator calls should leave exactly one Gmail digest
  // on disk — the newer call replaces the earlier one in place.
  test("second call replaces the first via one-per-source rule", async () => {
    const first = await generateGmailDigest(
      new Date("2026-04-14T12:00:00.000Z"),
      async () => 2,
    );
    expect(first).not.toBeNull();

    const second = await generateGmailDigest(
      new Date("2026-04-14T13:00:00.000Z"),
      async () => 9,
    );
    expect(second).not.toBeNull();
    expect(second!.id).not.toBe(first!.id);

    const raw = readFileSync(getHomeFeedPath(), "utf-8");
    const file = JSON.parse(raw) as {
      items: Array<{
        id: string;
        type: string;
        source?: string;
        title: string;
      }>;
    };

    const gmailDigests = file.items.filter(
      (i) => i.type === "digest" && i.source === "gmail",
    );
    expect(gmailDigests.length).toBe(1);
    expect(gmailDigests[0]!.id).toBe(second!.id);
    expect(gmailDigests[0]!.title).toBe("9 new emails");
  });
});
