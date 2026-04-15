import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// Stub the in-process SSE hub so the writer's publish path is a
// no-op in these tests. Must be in place before the writer module is
// imported (directly or transitively) so the dynamic import below
// picks it up.
const publishSpy = mock<(event: unknown) => Promise<void>>(async () => {});

mock.module("../../runtime/assistant-event-hub.js", () => ({
  assistantEventHub: {
    publish: publishSpy,
    subscribe: () => () => {},
  },
}));

const { emitFeedEvent } = await import("../emit-feed-event.js");
const { getHomeFeedPath } = await import("../feed-writer.js");

interface OnDiskItem {
  id: string;
  type: string;
  source?: string;
  title: string;
  summary: string;
  priority: number;
  status: string;
  author: string;
  createdAt: string;
  expiresAt?: string;
  minTimeAway?: number;
}

function readFileJson(): {
  version: number;
  items: OnDiskItem[];
  updatedAt: string;
} {
  return JSON.parse(readFileSync(getHomeFeedPath(), "utf-8"));
}

let workspaceDir: string;
let origWorkspaceDir: string | undefined;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "vellum-emit-"));
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

describe("emitFeedEvent", () => {
  test("writes an assistant-authored action item with the opinionated defaults", async () => {
    const result = await emitFeedEvent({
      source: "gmail",
      title: "Replied to Alice",
      summary: "Sent a reply to Alice's question about lunch.",
    });

    expect(result.type).toBe("action");
    expect(result.author).toBe("assistant");
    expect(result.source).toBe("gmail");
    expect(result.status).toBe("new");
    expect(result.expiresAt).toBeUndefined();
    // Default priority: above platform baseline (40), below the
    // assistant nudge default (60).
    expect(result.priority).toBe(50);

    const decoded = readFileJson();
    expect(decoded.items).toHaveLength(1);
    const persisted = decoded.items[0]!;
    expect(persisted.id).toBe(result.id);
    expect(persisted.type).toBe("action");
    expect(persisted.author).toBe("assistant");
    expect(persisted.title).toBe("Replied to Alice");
    expect(persisted.expiresAt).toBeUndefined();
  });

  test("dedupKey produces a deterministic id so repeat emits update in place", async () => {
    await emitFeedEvent({
      source: "gmail",
      title: "Unread from Alice",
      summary: "One unread thread from alice@example.com.",
      dedupKey: "unread-msg-42",
    });
    await emitFeedEvent({
      source: "gmail",
      title: "Unread from Alice (now 2 messages)",
      summary: "Two unread threads from alice@example.com.",
      dedupKey: "unread-msg-42",
    });

    const decoded = readFileJson();
    expect(decoded.items).toHaveLength(1);
    const item = decoded.items[0]!;
    expect(item.id).toBe("emit:gmail:unread-msg-42");
    expect(item.title).toBe("Unread from Alice (now 2 messages)");
  });

  test("omitting dedupKey produces a fresh id on every call", async () => {
    const a = await emitFeedEvent({
      source: "slack",
      title: "Sent reply in #general",
      summary: "Posted a reply in #general.",
    });
    const b = await emitFeedEvent({
      source: "slack",
      title: "Sent reply in #alerts",
      summary: "Posted a reply in #alerts.",
    });

    expect(a.id).not.toBe(b.id);
    const decoded = readFileJson();
    expect(decoded.items).toHaveLength(2);
  });

  test("explicit expiresAt is preserved and round-trips to disk", async () => {
    const explicit = "2026-04-20T00:00:00.000Z";
    await emitFeedEvent({
      source: "calendar",
      title: "Meeting prep reminder",
      summary: "Standup in 30 minutes — agenda is empty.",
      expiresAt: explicit,
      dedupKey: "standup-prep",
    });

    const decoded = readFileJson();
    expect(decoded.items[0]!.expiresAt).toBe(explicit);
  });

  test("explicit priority overrides the default", async () => {
    await emitFeedEvent({
      source: "assistant",
      title: "Ran weekly review",
      summary: "Consolidated last week's activity into a digest.",
      priority: 75,
      dedupKey: "weekly-review",
    });

    const decoded = readFileJson();
    expect(decoded.items[0]!.priority).toBe(75);
  });

  test("out-of-range priority throws a ZodError at the source", async () => {
    await expect(
      emitFeedEvent({
        source: "gmail",
        title: "Valid title",
        summary: "Valid summary",
        priority: 150,
      }),
    ).rejects.toThrow();
  });
});
