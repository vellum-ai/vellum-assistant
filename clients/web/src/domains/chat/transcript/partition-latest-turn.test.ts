import { describe, expect, test } from "bun:test";

import type { DisplayMessage } from "@/domains/chat/types/types";
import { partitionLatestTurn } from "@/domains/chat/transcript/partition-latest-turn";
import type {
  MessageItem,
  ThinkingItem,
  TranscriptItem,
} from "@/domains/chat/transcript/types";

import { textBody } from "@/domains/chat/utils/message-test-helpers";
function makeMessage(
  overrides: Omit<DisplayMessage, "id"> & { id?: string },
): DisplayMessage {
  const { id, ...rest } = overrides;
  return {
    id: id ?? crypto.randomUUID(),
    ...rest,
  };
}

function messageItem(message: DisplayMessage): MessageItem {
  return { kind: "message", key: message.id, message };
}

function thinkingItem(): ThinkingItem {
  return { kind: "thinking", key: "thinking", active: true };
}

describe("partitionLatestTurn", () => {
  test("empty items → null anchor, empty history + response", () => {
    const partition = partitionLatestTurn([]);
    expect(partition).toEqual({
      historyItems: [],
      anchorMessage: null,
      responseItems: [],
    });
  });

  test("no user messages at all → anchor null, history = full items, response = []", () => {
    const a1 = makeMessage({ id: "m1", role: "assistant", ...textBody("A"),  });
    const a2 = makeMessage({ id: "m2", role: "assistant", ...textBody("B"),  });
    const items: TranscriptItem[] = [messageItem(a1), messageItem(a2), thinkingItem()];

    const partition = partitionLatestTurn(items);
    expect(partition.anchorMessage).toBeNull();
    expect(partition.historyItems).toEqual(items);
    expect(partition.responseItems).toEqual([]);
    // returns a fresh slice, not the original array
    expect(partition.historyItems).not.toBe(items);
  });

  test("single user message, no response → anchor matches, response empty", () => {
    const user = makeMessage({ id: "m1", role: "user", ...textBody("Hi"),  });
    const userItem = messageItem(user);
    const items: TranscriptItem[] = [userItem];

    const partition = partitionLatestTurn(items);
    expect(partition.anchorMessage).toBe(userItem);
    expect(partition.historyItems).toEqual([]);
    expect(partition.responseItems).toEqual([]);
  });

  test("multi-turn history with trailing assistant + thinking/surface/error all end up in responseItems", () => {
    const u1 = makeMessage({ id: "m1", role: "user", ...textBody("Hi"),  });
    const a1 = makeMessage({ id: "m2", role: "assistant", ...textBody("Hello"),  });
    const u2 = makeMessage({ id: "m3", role: "user", ...textBody("More"),  });
    const a2 = makeMessage({ id: "m4", role: "assistant", ...textBody("Sure"),  });

    const u1Item = messageItem(u1);
    const a1Item = messageItem(a1);
    const u2Item = messageItem(u2);
    const a2Item = messageItem(a2);
    const think = thinkingItem();

    const items: TranscriptItem[] = [u1Item, a1Item, u2Item, a2Item, think];

    const partition = partitionLatestTurn(items);
    expect(partition.anchorMessage).toBe(u2Item);
    expect(partition.historyItems).toEqual([u1Item, a1Item]);
    expect(partition.responseItems).toEqual([a2Item, think]);
  });

  test("picks the LAST user message when multiple user messages exist", () => {
    const u1 = makeMessage({ id: "m1", role: "user", ...textBody("First"),  });
    const u2 = makeMessage({ id: "m2", role: "user", ...textBody("Second"),  });
    const u1Item = messageItem(u1);
    const u2Item = messageItem(u2);

    const partition = partitionLatestTurn([u1Item, u2Item]);
    expect(partition.anchorMessage).toBe(u2Item);
    expect(partition.historyItems).toEqual([u1Item]);
    expect(partition.responseItems).toEqual([]);
  });

  test("does not treat a non-message item as an anchor", () => {
    // Trailers alone must not become the anchor even though they come
    // after all messages.
    const items: TranscriptItem[] = [thinkingItem()];
    const partition = partitionLatestTurn(items);
    expect(partition.anchorMessage).toBeNull();
    expect(partition.historyItems).toEqual(items);
    expect(partition.responseItems).toEqual([]);
  });

  test("assistant-only MessageItems never anchor", () => {
    const a1 = makeMessage({ id: "m1", role: "assistant", ...textBody("A"),  });
    const a2 = makeMessage({ id: "m2", role: "assistant", ...textBody("B"),  });
    const items: TranscriptItem[] = [messageItem(a1), messageItem(a2)];

    const partition = partitionLatestTurn(items);
    expect(partition.anchorMessage).toBeNull();
    expect(partition.historyItems).toEqual(items);
    expect(partition.responseItems).toEqual([]);
  });
});
