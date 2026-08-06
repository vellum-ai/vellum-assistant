/**
 * Tests for `HomeToolPermissionCard`.
 *
 * Uses `renderToStaticMarkup` (SSR) like `notifications-bell.test.tsx`. The
 * card is presentational, so static markup covers it fully.
 *
 * The no-provider branch is the one that matters: the panel header above this
 * card already renders `item.title`, so the card must show the body. Now that
 * the daemon sets a title on every feed item, echoing the title here would
 * print the same string twice.
 */

import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { FeedItem } from "@vellumai/assistant-api";

import { feedItem } from "../feed-test-fixtures";

import { HomeToolPermissionCard } from "./home-tool-permission-card";

function permissionItem(overrides: Partial<FeedItem> = {}): FeedItem {
  return feedItem({
    id: "notif:1",
    summary: "Gmail lost access to the mailbox scope.",
    timestamp: "2026-01-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  });
}

function render(item: FeedItem): string {
  return renderToStaticMarkup(createElement(HomeToolPermissionCard, { item }));
}

describe("HomeToolPermissionCard without a provider", () => {
  test("renders the summary, not the title", () => {
    const html = render(
      permissionItem({
        title: "Gmail Access Lost",
        summary: "Gmail lost access to the mailbox scope.",
      }),
    );

    expect(html).toContain("Gmail lost access to the mailbox scope.");
    expect(html).not.toContain("Gmail Access Lost");
  });

  test("does not repeat a title that matches the summary", () => {
    // The daemon derives a title from the summary when no authored candidate
    // survives, so the two can legitimately be identical. The card must still
    // render the string once.
    const shared = "Gmail lost access to the mailbox scope.";
    const html = render(permissionItem({ title: shared, summary: shared }));

    expect(html.split(shared).length - 1).toBe(1);
  });

  test("still renders when the daemon omits a title", () => {
    // Older daemons omit `title`; web ships always-latest, so this path stays
    // reachable.
    const html = render(permissionItem({ title: undefined }));

    expect(html).toContain("Gmail lost access to the mailbox scope.");
  });
});

describe("HomeToolPermissionCard with a provider", () => {
  test("renders the provider detail view instead of the summary", () => {
    const html = render(
      permissionItem({
        title: "Gmail Access Lost",
        metadata: {
          provider: "gmail",
          status: "unreachable",
          details: "Token expired.",
        },
      }),
    );

    expect(html).toContain("Token expired.");
    expect(html).not.toContain("Gmail lost access to the mailbox scope.");
  });
});
