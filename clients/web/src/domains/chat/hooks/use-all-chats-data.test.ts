import { describe, expect, test } from "bun:test";

import { isUnsupportedCombinedRead } from "@/domains/chat/hooks/use-all-chats-data";
import { ApiError } from "@/utils/api-errors";
import { MessageOrderedHistoryError } from "@/utils/conversation-list-fetchers";

describe("isUnsupportedCombinedRead", () => {
  test("an assistant that rejects the combined read falls back", () => {
    expect(isUnsupportedCombinedRead(new ApiError(400, "Unknown value"))).toBe(
      true,
    );
  });

  test("an assistant that pages it by message recency falls back", () => {
    expect(isUnsupportedCombinedRead(new MessageOrderedHistoryError())).toBe(
      true,
    );
  });

  test("a transient failure keeps the combined read", () => {
    expect(isUnsupportedCombinedRead(new ApiError(503, "Starting up"))).toBe(
      false,
    );
    expect(isUnsupportedCombinedRead(new TypeError("Failed to fetch"))).toBe(
      false,
    );
    expect(isUnsupportedCombinedRead(null)).toBe(false);
  });
});
