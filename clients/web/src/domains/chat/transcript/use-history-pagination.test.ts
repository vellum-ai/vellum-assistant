import { describe, expect, test } from "bun:test";

import {
  aggregateBackgroundToolCompletions,
  aggregateSubagentNotifications,
} from "@/domains/chat/transcript/use-history-pagination";
import type { RuntimeSubagentNotification } from "@/domains/chat/api/messages";
import type { BackgroundTaskEntry } from "@/domains/chat/background-task-store";
import type { PaginatedHistoryResult } from "@/domains/chat/transcript/types";

function notif(
  subagentId: string,
  status: string,
): RuntimeSubagentNotification {
  return { subagentId, label: subagentId, status } as RuntimeSubagentNotification;
}

function completion(id: string): BackgroundTaskEntry {
  return {
    id,
    toolName: "bash",
    conversationId: "conv-1",
    command: `echo ${id}`,
    startedAt: 0,
    status: "completed",
  };
}

function page(
  subagentNotifications?: RuntimeSubagentNotification[],
  backgroundToolCompletions?: BackgroundTaskEntry[],
): PaginatedHistoryResult {
  return {
    messages: [],
    hasMore: false,
    oldestTimestamp: null,
    oldestMessageId: null,
    ...(subagentNotifications ? { subagentNotifications } : {}),
    ...(backgroundToolCompletions ? { backgroundToolCompletions } : {}),
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

describe("aggregateBackgroundToolCompletions", () => {
  test("returns undefined for no pages", () => {
    expect(aggregateBackgroundToolCompletions(undefined)).toBeUndefined();
    expect(aggregateBackgroundToolCompletions([])).toBeUndefined();
  });

  test("returns undefined when no page carries completions", () => {
    expect(
      aggregateBackgroundToolCompletions([page(), page()]),
    ).toBeUndefined();
  });

  test("returns a single page's completions", () => {
    const result = aggregateBackgroundToolCompletions([
      page(undefined, [completion("bg-a")]),
    ]);
    expect(result?.map((c) => c.id)).toEqual(["bg-a"]);
  });

  test("concatenates completions from multiple pages, oldest-first", () => {
    // pages[0] = latest page, pages[1] = older. Completions from the older
    // page must come first so first-seen order is preserved for seeding.
    const pages = [
      page(undefined, [completion("bg-late"), completion("bg-latest")]),
      page(undefined, [completion("bg-early")]),
    ];
    const result = aggregateBackgroundToolCompletions(pages);
    expect(result?.map((c) => c.id)).toEqual([
      "bg-early",
      "bg-late",
      "bg-latest",
    ]);
  });
});
