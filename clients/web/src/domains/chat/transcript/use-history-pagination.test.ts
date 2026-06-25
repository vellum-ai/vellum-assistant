import { describe, expect, test } from "bun:test";

import { aggregateSubagentNotifications } from "@/domains/chat/transcript/use-history-pagination";
import type { RuntimeSubagentNotification } from "@/domains/chat/api/messages";
import type { PaginatedHistoryResult } from "@/domains/chat/transcript/types";

function notif(
  subagentId: string,
  status: string,
): RuntimeSubagentNotification {
  return { subagentId, label: subagentId, status } as RuntimeSubagentNotification;
}

function page(
  subagentNotifications?: RuntimeSubagentNotification[],
): PaginatedHistoryResult {
  return {
    messages: [],
    hasMore: false,
    oldestTimestamp: null,
    oldestMessageId: null,
    ...(subagentNotifications ? { subagentNotifications } : {}),
  };
}

describe("aggregateSubagentNotifications", () => {
  test("returns undefined for no pages", () => {
    expect(aggregateSubagentNotifications(undefined)).toBeUndefined();
    expect(aggregateSubagentNotifications([])).toBeUndefined();
  });

  test("returns undefined when no page carries notifications", () => {
    expect(aggregateSubagentNotifications([page(), page()])).toBeUndefined();
  });

  test("returns a single page's notifications", () => {
    const result = aggregateSubagentNotifications([page([notif("a", "completed")])]);
    expect(result?.map((n) => n.subagentId)).toEqual(["a"]);
  });

  test("includes notifications from OLDER pages, oldest-first (regression: aborted-early subagent)", () => {
    // pages[0] = latest page, pages[1] = older. The aborted subagent's
    // notification lives only in the older page; it must still be aggregated.
    const pages = [
      page([notif("completed-late", "completed")]),
      page([notif("aborted-early", "aborted")]),
    ];
    const result = aggregateSubagentNotifications(pages);
    expect(result?.map((n) => n.subagentId)).toEqual([
      "aborted-early",
      "completed-late",
    ]);
  });
});
