/**
 * `refreshConversationRow` treats a 404 as "this row is gone" whether it
 * arrives as the detail fetcher's own `ConversationNotFoundError` or as an
 * `ApiError` from a deduped in-flight `throwOnError` fetch of the same row.
 * Anything else is rethrown so the caller can report it.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";

import { ApiError } from "@/utils/api-errors";

let fetchImpl: () => Promise<never> = async () => {
  throw new Error("unset");
};

const realFetchDetail = await import("@/utils/fetch-conversation-detail");
mock.module("@/utils/fetch-conversation-detail", () => ({
  ...realFetchDetail,
  fetchConversationDetail: () => fetchImpl(),
}));

const { refreshConversationRow } =
  await import("@/utils/conversation-cache-mutations");

let queryClient: QueryClient;

beforeEach(() => {
  queryClient = new QueryClient();
});

describe("refreshConversationRow", () => {
  test("swallows a 404 ApiError like a ConversationNotFoundError", async () => {
    // GIVEN the detail fetch rejects with a status-carrying 404
    fetchImpl = async () => {
      throw new ApiError(404, "Conversation conv-1 not found");
    };

    // WHEN the row is refreshed
    // THEN it resolves instead of rethrowing (no retry, no error capture)
    await expect(
      refreshConversationRow(queryClient, "asst-1", "conv-1"),
    ).resolves.toBeUndefined();
  });

  test("swallows the fetcher's own ConversationNotFoundError", async () => {
    fetchImpl = async () => {
      throw new realFetchDetail.ConversationNotFoundError("conv-1");
    };

    await expect(
      refreshConversationRow(queryClient, "asst-1", "conv-1"),
    ).resolves.toBeUndefined();
  });

  test("rethrows other failures", async () => {
    fetchImpl = async () => {
      throw new ApiError(500, "boom");
    };

    await expect(
      refreshConversationRow(queryClient, "asst-1", "conv-1"),
    ).rejects.toBeInstanceOf(ApiError);
  });
});
