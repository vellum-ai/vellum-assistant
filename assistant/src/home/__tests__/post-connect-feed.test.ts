import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// ─── assistantEventHub mock ────────────────────────────────────────────
const publishSpy = mock<(event: unknown) => Promise<void>>(async () => {});

mock.module("../../runtime/assistant-event-hub.js", () => ({
  assistantEventHub: {
    publish: publishSpy,
    subscribe: () => () => {},
  },
  broadcastMessage: async () => {},
}));

const { emitPostConnectNudge } = await import("../post-connect-feed.js");
const { readHomeFeed } = await import("../feed-writer.js");

// ─── tmpdir workspace lifecycle ────────────────────────────────────────

let workspaceDir: string;
let origWorkspaceDir: string | undefined;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "vellum-pcf-"));
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

describe("emitPostConnectNudge", () => {
  test("emits a notification feed item for google", async () => {
    await emitPostConnectNudge("google");

    const feed = readHomeFeed();
    expect(feed.items).toHaveLength(1);

    const item = feed.items[0]!;
    expect(item.id).toBe("connect-nudge:google");
    expect(item.type).toBe("notification");
    expect(item.title).toContain("Gmail connected");
    expect(item.actions).toHaveLength(2);
    expect(item.actions![0]!.label).toBe("Triage my inbox");
    expect(item.actions![1]!.label).toBe("Set up daily digest");
    expect(item.expiresAt).toBeDefined();
  });

  test("no-ops for non-email services", async () => {
    await emitPostConnectNudge("slack");
    await emitPostConnectNudge("notion");
    await emitPostConnectNudge("linear");

    const feed = readHomeFeed();
    expect(feed.items).toHaveLength(0);
  });

  test("reconnecting replaces the existing notification in place (deterministic id)", async () => {
    await emitPostConnectNudge("google");
    await emitPostConnectNudge("google");

    const feed = readHomeFeed();
    // The deterministic `connect-nudge:<service>` id triggers the v2
    // writer's "same id replaces in place" rule, so reconnecting
    // produces a single feed entry rather than appending a duplicate.
    expect(feed.items).toHaveLength(1);
    expect(feed.items[0]!.id).toBe("connect-nudge:google");
  });

  test("notification expires after 7 days", async () => {
    await emitPostConnectNudge("google");

    const feed = readHomeFeed();
    const item = feed.items[0]!;
    const created = new Date(item.createdAt).getTime();
    const expires = new Date(item.expiresAt!).getTime();
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;

    // Allow 1 second tolerance for test execution time
    expect(Math.abs(expires - created - sevenDaysMs)).toBeLessThan(1000);
  });
});
