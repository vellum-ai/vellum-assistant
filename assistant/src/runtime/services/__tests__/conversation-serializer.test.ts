/**
 * Unit tests for `serializeConversationSummary` — specifically the wire-level
 * `groupId` normalization for surfaced conversations.
 *
 * Surfaced rows (`surfaced_at IS NOT NULL`) must serialize with
 * `groupId: "system:all"` when their persisted group is the system
 * Background/Scheduled bucket (or null), so legacy clients that bucket purely
 * by `groupId` (macOS Swift app) render them in Recents without decoding
 * `surfacedAt`. The persisted DB value is untouched — clearing `surfaced_at`
 * (demotion) makes serialization return the original group again.
 */

import { describe, expect, test } from "bun:test";

import type { ConversationRow } from "../../../persistence/conversation-crud.js";
import { serializeConversationSummary } from "../conversation-serializer.js";

function makeConversationRow(
  overrides: Partial<ConversationRow> = {},
): ConversationRow {
  return {
    id: "conv-123",
    title: "Background run",
    createdAt: 1000,
    updatedAt: 2000,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalEstimatedCost: 0,
    contextSummary: null,
    contextCompactedMessageCount: 0,
    contextCompactedAt: null,
    historyStrippedAt: null,
    slackContextCompactionWatermarkTs: null,
    slackContextCompactionWatermarkAt: null,
    conversationType: "background",
    source: "task",
    originChannel: null,
    originInterface: null,
    forkParentConversationId: null,
    forkParentMessageId: null,
    isAutoTitle: 0,
    scheduleJobId: null,
    lastMessageAt: 3000,
    archivedAt: null,
    surfacedAt: null,
    inferenceProfile: null,
    enabledPlugins: null,
    inferenceProfileSessionId: null,
    inferenceProfileExpiresAt: null,
    lastNotifiedInferenceProfile: null,
    processingStartedAt: null,
    ...overrides,
  };
}

function serialize(
  conversation: ConversationRow,
  groupId: string | null = null,
  isPinned = false,
) {
  return serializeConversationSummary({
    conversation,
    displayMeta: { displayOrder: null, isPinned, groupId },
    parentCache: new Map(),
    isProcessing: false,
  });
}

describe("serializeConversationSummary · surfaced groupId normalization", () => {
  test("surfaced row with persisted system:background serializes as system:all", () => {
    const summary = serialize(
      makeConversationRow({ surfacedAt: 1704067200000 }),
      "system:background",
    );
    expect(summary.groupId).toBe("system:all");
    expect(summary.surfacedAt).toBe(1704067200000);
  });

  test("surfaced row with persisted system:scheduled serializes as system:all", () => {
    const summary = serialize(
      makeConversationRow({
        conversationType: "scheduled",
        source: "schedule",
        surfacedAt: 1704067200000,
      }),
      "system:scheduled",
    );
    expect(summary.groupId).toBe("system:all");
    expect(summary.surfacedAt).toBe(1704067200000);
  });

  test("surfaced row with null persisted group serializes as system:all", () => {
    // Legacy clients re-derive a null groupId into Background/Scheduled from
    // `source`, so the surfaced normalization must cover the null case too.
    const summary = serialize(
      makeConversationRow({ surfacedAt: 1704067200000 }),
      null,
    );
    expect(summary.groupId).toBe("system:all");
  });

  test("after demotion (surfaced_at cleared) the original group comes back", () => {
    const summary = serialize(
      makeConversationRow({ surfacedAt: null }),
      "system:background",
    );
    expect(summary.groupId).toBe("system:background");
    expect(summary.surfacedAt).toBeUndefined();
  });

  test("a custom group wins over surfacing", () => {
    // Mirrors web's getEffectiveGroupId precedence: user-created groups
    // take priority over the surfaced promotion.
    const summary = serialize(
      makeConversationRow({ surfacedAt: 1704067200000 }),
      "group-custom-1",
    );
    expect(summary.groupId).toBe("group-custom-1");
    expect(summary.surfacedAt).toBe(1704067200000);
  });

  test("a pin wins over surfacing", () => {
    const summary = serialize(
      makeConversationRow({ surfacedAt: 1704067200000 }),
      "system:pinned",
      true,
    );
    expect(summary.groupId).toBe("system:pinned");
    expect("isPinned" in summary && summary.isPinned).toBe(true);
  });

  test("non-surfaced rows pass the persisted group through untouched", () => {
    expect(serialize(makeConversationRow(), null).groupId).toBeNull();
    expect(serialize(makeConversationRow(), "system:scheduled").groupId).toBe(
      "system:scheduled",
    );
    expect(serialize(makeConversationRow(), "group-custom-1").groupId).toBe(
      "group-custom-1",
    );
  });
});

describe("serializeConversationSummary · enabledPlugins", () => {
  test("serializes a non-empty plugin scope", () => {
    const summary = serialize(
      makeConversationRow({ enabledPlugins: ["plugin-a", "plugin-b"] }),
    );
    expect(summary.enabledPlugins).toEqual(["plugin-a", "plugin-b"]);
  });

  test("preserves an explicit empty scope (user cleared all optional plugins)", () => {
    const summary = serialize(makeConversationRow({ enabledPlugins: [] }));
    expect(summary.enabledPlugins).toEqual([]);
  });

  test("omits the field when there is no per-chat restriction (null)", () => {
    const summary = serialize(makeConversationRow({ enabledPlugins: null }));
    expect("enabledPlugins" in summary).toBe(false);
  });
});
