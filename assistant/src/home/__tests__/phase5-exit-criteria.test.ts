/**
 * Phase 5 exit-criteria end-to-end test.
 *
 * Exercises the full home-feed flow in-process against a tmpdir
 * workspace: the platform-baseline generator writes a digest, the
 * assistant-authoring helper writes a nudge, the HTTP route serves
 * both with a context banner, and the patch endpoint flips an item
 * to `seen` — all without spinning up the macOS app.
 *
 * Exit-criteria mapping (from the TDD checklist):
 *
 *   [x] platform-baseline Gmail digest surfaces via the feed route
 *       → `generateGmailDigest(now)` + `GET /v1/home/feed` → 1 item
 *   [x] assistant-authored nudges coexist with platform digests
 *       → `writeAssistantFeedItem(...)` → 2 items visible
 *   [x] `minTimeAway` filtering behaves at route boundary
 *       → seed an item with `minTimeAway: 3600` and query with
 *         `timeAwaySeconds: 12 * 3600` → included
 *   [x] context banner reports `newCount` across all authors
 *       → 2 new items → banner.newCount === 2
 *   [x] `PATCH /v1/home/feed/:id` flips status and mutates banner
 *       → patchFeedItemStatus(nudgeId, "seen") → newCount drops to 1
 *
 * This test is a wiring-regression safety net — the per-PR unit
 * tests in this directory (feed-writer, feed-types, authoring,
 * gmail-digest, plus the route tests under `runtime/routes/__tests__`)
 * still carry the per-component coverage. Keep this file fast (<5s)
 * by doing all persistence against a single tmpdir workspace and
 * calling route handlers directly instead of standing up the HTTP
 * server.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// ─── assistantEventHub mock ────────────────────────────────────────────
// The real feed writer publishes `home_feed_updated` via the in-process
// event hub on every write. This test doesn't assert on those events —
// it asserts on the feed file + HTTP-route output — so we stub the hub
// to an inert publisher. Must run before the first dynamic import of
// anything that transitively imports `feed-writer.js`.
const publishSpy = mock<(event: unknown) => Promise<void>>(async () => {});
mock.module("../../runtime/assistant-event-hub.js", () => ({
  assistantEventHub: {
    publish: publishSpy,
    subscribe: () => () => {},
  },
}));

// ─── createConversation / addMessage stub ──────────────────────────────
// The feed action endpoint (`POST /v1/home/feed/:id/actions/:actionId`)
// calls into the real conversation store, which drags in a large chunk
// of daemon state we don't want this test to depend on. The exit-
// criteria flow we care about is GET + PATCH — not the action POST —
// so we stub the conversation module to a trivial in-memory fake and
// never exercise it. If a future exit-criteria item needs the action
// path, swap this for a real-ish fake.
mock.module("../../runtime/conversation-store.js", () => ({
  createConversation: (args: { title: string; source: string }) => ({
    id: "stub-conversation",
    title: args.title,
    source: args.source,
  }),
  addMessage: async () => {},
}));

const { generateGmailDigest } = await import("../platform-gmail-digest.js");
const { writeAssistantFeedItem } =
  await import("../assistant-feed-authoring.js");
const { patchFeedItemStatus, readHomeFeed } = await import("../feed-writer.js");
const { handleGetHomeFeed } =
  await import("../../runtime/routes/home-feed-routes.js");

// ─── tmpdir workspace lifecycle ────────────────────────────────────────

let workspaceDir: string;
let origWorkspaceDir: string | undefined;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "vellum-phase5-e2e-"));
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
    // best-effort — tests must not fail on cleanup
  }
});

// ─── Helpers ───────────────────────────────────────────────────────────

/** Hit the GET handler directly with a synthetic Request object. */
async function getFeed(timeAwaySeconds: number): Promise<{
  items: Array<{
    id: string;
    status: string;
    type: string;
    source?: string;
    author: string;
  }>;
  updatedAt: string;
  contextBanner: { greeting: string; timeAwayLabel: string; newCount: number };
}> {
  const req = new Request(
    `http://daemon.local/v1/home/feed?timeAwaySeconds=${timeAwaySeconds}`,
  );
  const res = await handleGetHomeFeed(req);
  expect(res.status).toBe(200);
  return (await res.json()) as Awaited<ReturnType<typeof getFeed>>;
}

// ─── Tests ─────────────────────────────────────────────────────────────

describe("Phase 5 exit criteria — end-to-end", () => {
  test("platform digest + assistant nudge surface via the feed route, and patch flips newCount", async () => {
    const now = new Date("2026-04-14T12:00:00.000Z");

    // 1. Platform baseline: Gmail digest — mechanical "3 new emails"
    const digest = await generateGmailDigest(now, async () => 3);
    expect(digest).not.toBeNull();
    expect(digest!.source).toBe("gmail");
    expect(digest!.author).toBe("platform");
    expect(digest!.type).toBe("digest");

    // 2. Assistant-authored nudge — the hybrid-authoring surface
    const nudge = await writeAssistantFeedItem({
      type: "nudge",
      source: "assistant",
      title: "Follow up on the Figma file",
      summary: "Alice is asking when the deck lands.",
      actions: [
        {
          id: "open",
          label: "Open conversation",
          prompt: "Remind me about the Figma file.",
        },
      ],
      minTimeAway: 3600,
    });
    expect(nudge.author).toBe("assistant");
    expect(nudge.type).toBe("nudge");

    // 3. On-disk sanity: both items made it into home-feed.json and
    //    the digest coexists with the assistant nudge (different
    //    (type, source) so the one-per-source replacement does not
    //    collapse them into a single item).
    const onDisk = readHomeFeed();
    const ids = onDisk.items.map((i) => i.id).sort();
    expect(ids.length).toBe(2);
    expect(ids).toContain(digest!.id);
    expect(ids).toContain(nudge.id);

    // 4. Route: `GET /v1/home/feed?timeAwaySeconds=43200` — both items
    //    pass the `minTimeAway` gate (3600 <= 43200). Banner reports
    //    `newCount: 2` since both are still `.new`.
    const initial = await getFeed(12 * 3600);
    expect(initial.items.length).toBe(2);
    expect(initial.contextBanner.newCount).toBe(2);
    expect(initial.contextBanner.timeAwayLabel.length).toBeGreaterThan(0);
    expect(initial.contextBanner.greeting.length).toBeGreaterThan(0);

    // 5. Flip the nudge to `seen` via the writer (the route's PATCH
    //    handler is a thin wrapper around this — we skip the HTTP
    //    layer here so the test stays at the in-process seam).
    const patched = await patchFeedItemStatus(nudge.id, "seen");
    expect(patched).not.toBeNull();
    expect(patched!.status).toBe("seen");

    // 6. Re-fetch: `newCount` drops to 1 (only the digest is still
    //    `.new`). Total item count is unchanged — patching status
    //    must never remove items from the feed.
    const afterPatch = await getFeed(12 * 3600);
    expect(afterPatch.items.length).toBe(2);
    expect(afterPatch.contextBanner.newCount).toBe(1);
    const seenItem = afterPatch.items.find((i) => i.id === nudge.id);
    expect(seenItem?.status).toBe("seen");
  });

  test("minTimeAway gate excludes items when the user has not been away long enough", async () => {
    // Assistant nudge with a 1-hour away gate
    const nudge = await writeAssistantFeedItem({
      type: "nudge",
      source: "assistant",
      title: "Come back after lunch",
      summary: "This only shows after an hour away.",
      minTimeAway: 3600,
    });

    // User has only been away 10 minutes → item must be filtered
    const brief = await getFeed(600);
    const briefIds = brief.items.map((i) => i.id);
    expect(briefIds).not.toContain(nudge.id);
    expect(brief.contextBanner.newCount).toBe(0);

    // User has been away 2 hours → item must now appear
    const long = await getFeed(2 * 3600);
    const longIds = long.items.map((i) => i.id);
    expect(longIds).toContain(nudge.id);
    expect(long.contextBanner.newCount).toBe(1);
  });
});
