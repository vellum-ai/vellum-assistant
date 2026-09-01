/**
 * Tests for `HomeDetailPanel`'s dismiss gating.
 *
 * Uses `renderToStaticMarkup` (SSR) like `home-tool-permission-card.test.tsx`:
 * the footer's controls are pure renders of the item, so static markup covers
 * the pending-vs-receipt distinction on both the desktop footer and the
 * header's shared status actions.
 */

import { describe, expect, mock, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { FeedItem } from "@vellumai/assistant-api";

import { feedItem } from "../feed-test-fixtures";

// The guardian card inside the panel reads the decision mutation and the
// assistant store; both are stubbed so the panel renders without providers.
mock.module("@/generated/daemon/@tanstack/react-query.gen", () => ({
  useGuardianactionsDecisionPostMutation: () => ({
    mutate: () => {},
    isPending: false,
    data: undefined,
    variables: undefined,
    reset: () => {},
  }),
}));

mock.module("@/stores/resolved-assistants-store", () => {
  const store = () => null;
  store.use = {
    activeAssistantId: () => "assistant-1",
  };
  return { useResolvedAssistantsStore: store };
});

const { HomeDetailPanel } = await import("./home-detail-panel");

function renderPanel(item: FeedItem): string {
  return renderToStaticMarkup(
    createElement(HomeDetailPanel, {
      item,
      validConversationIds: new Set<string>(),
      onClose: () => {},
      onGoToThread: () => {},
      onUpdateStatus: () => {},
      onDismiss: () => {},
    }),
  );
}

function guardianItem(status: "pending" | "approved"): FeedItem {
  return feedItem({
    id: `guardian:req-${status}`,
    summary: "Alice asked the assistant to look up an issue",
    timestamp: "2026-08-31T12:00:00.000Z",
    createdAt: "2026-08-31T12:00:00.000Z",
    detailPanel: { kind: "permissionChat" },
    guardianRequest: {
      requestId: `req-${status}`,
      kind: "tool_approval",
      intent: "approval",
      status,
    },
  });
}

describe("HomeDetailPanel dismiss gating", () => {
  test("a pending guardian item renders no dismiss control", () => {
    const html = renderPanel(guardianItem("pending"));
    expect(html).not.toContain(">Dismiss<");
    expect(html).not.toContain('aria-label="Dismiss"');
  });

  test("its receipt renders the dismiss controls again", () => {
    const html = renderPanel(guardianItem("approved"));
    expect(html).toContain("Dismiss");
  });

  test("an ordinary notification keeps its dismiss controls", () => {
    const html = renderPanel(
      feedItem({
        id: "notif:routine",
        summary: "Routine update",
        timestamp: "2026-08-31T12:00:00.000Z",
        createdAt: "2026-08-31T12:00:00.000Z",
      }),
    );
    expect(html).toContain("Dismiss");
  });
});
