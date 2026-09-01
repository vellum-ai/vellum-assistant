/**
 * Tests for `FeedItemStatusActions`' dismiss gating.
 *
 * The controls are a pure render of the item, so `renderToStaticMarkup` (SSR)
 * covers the three cases that matter: an unresolved guardian request offers no
 * dismiss, its receipt offers one again, and an ordinary notification is never
 * affected by the rule.
 *
 * Lives on the shared component rather than on a surface that renders it, so
 * the rule stays covered wherever it is rendered.
 */

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { FeedItem } from "@vellumai/assistant-api";

import { feedItem } from "./feed-test-fixtures";
import { FeedItemStatusActions } from "./feed-item-status-actions";

function render(item: FeedItem): string {
  return renderToStaticMarkup(
    <FeedItemStatusActions
      item={item}
      onUpdateStatus={() => {}}
      onDismiss={() => {}}
    />,
  );
}

function guardianItem(status: "pending" | "approved"): FeedItem {
  return feedItem({
    id: `guardian:req-${status}`,
    summary: "Alice asked the assistant to look up an issue",
    detailPanel: { kind: "permissionChat" },
    guardianRequest: {
      requestId: `req-${status}`,
      kind: "tool_approval",
      intent: "approval",
      status,
    },
  });
}

describe("FeedItemStatusActions dismiss gating", () => {
  test("a pending guardian item renders no dismiss control", () => {
    expect(render(guardianItem("pending"))).not.toContain(
      'aria-label="Dismiss"',
    );
  });

  test("its receipt renders the dismiss control again", () => {
    expect(render(guardianItem("approved"))).toContain('aria-label="Dismiss"');
  });

  test("an ordinary notification keeps its dismiss control", () => {
    expect(
      render(feedItem({ id: "notif:routine", summary: "Routine update" })),
    ).toContain('aria-label="Dismiss"');
  });

  test("an item already dismissed offers restore in place of dismiss", () => {
    const html = render(
      feedItem({
        id: "notif:dismissed",
        summary: "Routine update",
        status: "dismissed",
      }),
    );
    expect(html).toContain('aria-label="Restore"');
    expect(html).not.toContain('aria-label="Dismiss"');
  });
});
