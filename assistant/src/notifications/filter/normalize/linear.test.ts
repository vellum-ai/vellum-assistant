/**
 * Pins the Linear mapping against the payload `watcher/providers/linear.ts`
 * actually builds, including the fallback that keeps an unrecognized event
 * type from throwing.
 */

import { describe, expect, test } from "bun:test";

import type { WatcherItem } from "../../../watcher/provider-types.js";
import { linearNormalizer } from "./linear.js";
import { NormalizedNotificationSchema } from "./types.js";

function linearItem(overrides: Partial<WatcherItem> = {}): WatcherItem {
  return {
    externalId: "notif-1",
    eventType: "linear_issue_assigned",
    summary: "Linear issue assigned to you in Team One / ENG-1: Ship it",
    payload: {
      notificationId: "notif-1",
      type: "issueAssignedToYou",
      issueId: "issue-1",
      issueIdentifier: "ENG-1",
      issueTitle: "Ship it",
      teamName: "Team One",
      updatedAt: "2026-08-01T00:00:00.000Z",
    },
    timestamp: 1_700_000_000_000,
    ...overrides,
  };
}

describe("linearNormalizer", () => {
  test("returns null from fetchFull absence: Linear ships full content in the poll", () => {
    expect(linearNormalizer.fetchFull).toBeUndefined();
  });

  test("produces a schema-valid record with no sender", () => {
    const result = linearNormalizer.normalize(linearItem());
    expect(result).not.toBeNull();
    expect(NormalizedNotificationSchema.parse(result)).toEqual(result!);
    expect(result!.source).toBe("linear");
    expect(result!.sender).toBeNull();
    expect(result!.externalId).toBe("notif-1");
    expect(result!.meta.timestamp).toBe(1_700_000_000_000);
  });

  test.each([
    ["linear_issue_assigned", "assignment"],
    ["linear_mention", "mention"],
    ["linear_comment_mention", "mention"],
    ["linear_status_changed", "fyi"],
    ["linear_notification", "fyi"],
    ["linear_something_new", "fyi"],
  ])("maps %s to %s", (eventType, category) => {
    const result = linearNormalizer.normalize(linearItem({ eventType }));
    expect(result?.content.category).toBe(category as never);
  });

  test("uses the issue as the project container with the team as display name", () => {
    const result = linearNormalizer.normalize(linearItem());
    expect(result?.container).toEqual({
      type: "project",
      id: "issue-1",
      displayName: "Team One",
    });
  });

  test("drops the container when the notification has no issue", () => {
    const result = linearNormalizer.normalize(
      linearItem({ payload: { teamName: "Team One" } }),
    );
    expect(result?.container).toBeNull();
  });

  test("uses the summary as the preview", () => {
    const result = linearNormalizer.normalize(linearItem());
    expect(result?.content.preview).toBe(
      "Linear issue assigned to you in Team One / ENG-1: Ship it",
    );
  });

  test("prefers the comment body for full content", () => {
    const result = linearNormalizer.normalize(
      linearItem({
        eventType: "linear_comment_mention",
        payload: {
          issueId: "issue-1",
          issueTitle: "Ship it",
          teamName: "Team One",
          commentBody: "Can you take a look?",
        },
      }),
    );
    expect(result?.content.full).toBe("Can you take a look?");
  });

  test("falls back to the issue title when there is no comment", () => {
    expect(linearNormalizer.normalize(linearItem())?.content.full).toBe(
      "Ship it",
    );
  });

  test("drops an item with no summary", () => {
    expect(
      linearNormalizer.normalize(linearItem({ summary: "  " })),
    ).toBeNull();
  });
});
