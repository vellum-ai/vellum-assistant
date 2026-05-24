/**
 * LUM-1890 Phase 1 — `serializeConversationSummary` emits the canonical
 * `conversationId` alongside the legacy `id` field.
 *
 * Both fields carry the same value (the daemon's internal `conversations.id`).
 * The `conversationId` field is forward-compat: it lets clients that prefer
 * the canonical name read it directly without re-mapping, enabling the
 * Phase 2 web migration to drop the `id` → `conversationId` mapping in
 * `parseConversation`.
 *
 * Removable from the wire when Phase 4 deprecates `id` (after macOS catches
 * up). Until then, both fields are emitted.
 */

import { describe, expect, mock, test } from "bun:test";

mock.module("../../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import type { ConversationRow } from "../../../memory/conversation-crud.js";
import { serializeConversationSummary } from "../conversation-serializer.js";

function buildConversationRow(
  overrides: Partial<ConversationRow> = {},
): ConversationRow {
  const now = Date.now();
  return {
    id: "conv-internal-id-123",
    title: "Test conversation",
    createdAt: now,
    updatedAt: now,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalEstimatedCost: 0,
    contextSummary: null,
    contextCompactedMessageCount: 0,
    contextCompactedAt: null,
    historyStrippedAt: null,
    slackContextCompactionWatermarkTs: null,
    slackContextCompactionWatermarkAt: null,
    conversationType: "standard",
    source: "user",
    memoryScopeId: "scope-1",
    originChannel: null,
    originInterface: null,
    forkParentConversationId: null,
    forkParentMessageId: null,
    ...overrides,
  } as ConversationRow;
}

describe("serializeConversationSummary — Phase 1 bilingual emission", () => {
  test("emits both `id` and `conversationId` with the same internal id value", () => {
    const conversation = buildConversationRow({ id: "conv-bilingual-abc" });
    const out = serializeConversationSummary({
      conversation,
      parentCache: new Map(),
    });

    expect(out.id).toBe("conv-bilingual-abc");
    expect(out.conversationId).toBe("conv-bilingual-abc");
    // Forward-compat guarantee: both fields always carry the same value
    // until Phase 4 drops `id`. Any divergence is a contract bug.
    expect(out.id).toBe(out.conversationId);
  });

  test("conversationId tracks id even when binding/attention/displayMeta are set", () => {
    const conversation = buildConversationRow({ id: "conv-with-meta-xyz" });
    const out = serializeConversationSummary({
      conversation,
      displayMeta: {
        displayOrder: 5,
        isPinned: true,
        groupId: "group-7",
      },
      parentCache: new Map(),
    });

    // The serializer return type is a discriminated union over the
    // display-meta variants; reach in via Record<string, unknown> for
    // the optional fields rather than narrowing.
    const outAsRecord = out as Record<string, unknown>;
    expect(out.id).toBe("conv-with-meta-xyz");
    expect(out.conversationId).toBe("conv-with-meta-xyz");
    expect(outAsRecord.isPinned).toBe(true);
    expect(outAsRecord.displayOrder).toBe(5);
  });
});
