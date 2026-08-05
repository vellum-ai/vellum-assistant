/**
 * The server-side unread conversation count: how the fetcher classifies
 * responses, and how the cache delta helper behaves.
 *
 * The count is read from `GET /v1/conversations/unread-count`. An assistant
 * without the route 404s it, and the client treats that as "unavailable"
 * (`null`) so consumers fall back to counting loaded conversations. Every
 * other failure has to stay a real failure, or an auth/server error would be
 * silently indistinguishable from an old assistant.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";

import { client as daemonClient } from "@/generated/daemon/client.gen";
import { ApiError } from "@/utils/api-errors";
import { adjustUnreadCountCache } from "@/utils/conversation-cache-mutations";
import {
  fetchUnreadConversationCount,
  unreadConversationCountQueryKey,
} from "@/utils/conversation-list-fetchers";

const ASSISTANT_ID = "assistant-1";

const originalGet = daemonClient.get;

afterEach(() => {
  daemonClient.get = originalGet;
});

/** Stub the daemon transport with one response for the next GET. */
function stubResponse(opts: { status: number; body?: unknown }): {
  calls: number;
} {
  const state = { calls: 0 };
  daemonClient.get = mock(async () => {
    state.calls += 1;
    const ok = opts.status < 400;
    return {
      data: ok ? opts.body : null,
      error: ok ? null : { message: "boom" },
      response: new Response(JSON.stringify(opts.body ?? {}), {
        status: opts.status,
      }),
    };
  }) as typeof daemonClient.get;
  return state;
}

/** Stub the daemon transport with a transport-level failure (no response). */
function stubNetworkFailure(): void {
  daemonClient.get = mock(async () => ({
    data: null,
    error: new Error("network down"),
    response: undefined,
  })) as unknown as typeof daemonClient.get;
}

describe("fetchUnreadConversationCount", () => {
  test("returns the count from a successful response", async () => {
    stubResponse({ status: 200, body: { count: 7 } });

    expect(await fetchUnreadConversationCount(ASSISTANT_ID)).toBe(7);
  });

  test("returns 0 as a count, not as unavailable", async () => {
    // Zero unread is a real answer; conflating it with `null` would make an
    // empty inbox fall back to the client-derived count for no reason.
    stubResponse({ status: 200, body: { count: 0 } });

    expect(await fetchUnreadConversationCount(ASSISTANT_ID)).toBe(0);
  });

  test("maps 404 to null so an assistant without the route reads as unavailable", async () => {
    stubResponse({ status: 404 });

    expect(await fetchUnreadConversationCount(ASSISTANT_ID)).toBeNull();
  });

  test("throws a status-carrying ApiError on auth failure", async () => {
    // 401 must not be swallowed into the feature-off value: the app's
    // no-retry-4xx policy keys off the attached status, and a silent null
    // would render a stale badge as though the assistant were merely old.
    stubResponse({ status: 401 });

    const err = await fetchUnreadConversationCount(ASSISTANT_ID).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(401);
  });

  test("throws a status-carrying ApiError on server failure", async () => {
    stubResponse({ status: 500 });

    const err = await fetchUnreadConversationCount(ASSISTANT_ID).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(500);
  });

  test("rethrows a transport failure so it retries as transient", async () => {
    stubNetworkFailure();

    await expect(fetchUnreadConversationCount(ASSISTANT_ID)).rejects.toThrow();
  });
});

describe("adjustUnreadCountCache", () => {
  function seededClient(value: number | null | undefined): QueryClient {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    if (value !== undefined) {
      client.setQueryData(unreadConversationCountQueryKey(ASSISTANT_ID), value);
    }
    return client;
  }

  function read(client: QueryClient): number | null | undefined {
    return client.getQueryData<number | null>(
      unreadConversationCountQueryKey(ASSISTANT_ID),
    );
  }

  test("applies a negative delta", () => {
    const client = seededClient(3);

    expect(adjustUnreadCountCache(client, ASSISTANT_ID, -1)).toBe(true);
    expect(read(client)).toBe(2);
  });

  test("applies a positive delta", () => {
    const client = seededClient(3);

    expect(adjustUnreadCountCache(client, ASSISTANT_ID, 1)).toBe(true);
    expect(read(client)).toBe(4);
  });

  test("a decrement past zero and its revert cancel out exactly", () => {
    // The revert applies the inverse delta, so the decrement must not clamp:
    // a decrement that saturated at zero would be undone by more than it
    // removed, leaving the badge reporting unread conversations that do not
    // exist. Display clamps instead (see useUnreadConversationCount).
    const client = seededClient(0);

    adjustUnreadCountCache(client, ASSISTANT_ID, -1);
    adjustUnreadCountCache(client, ASSISTANT_ID, 1);

    expect(read(client)).toBe(0);
  });

  test("a bulk decrement past zero and its per-item reverts cancel out exactly", () => {
    // Mark-all-read decrements once for the whole batch and reverts one row
    // at a time, so the same asymmetry would compound across the batch.
    const client = seededClient(1);

    adjustUnreadCountCache(client, ASSISTANT_ID, -3);
    adjustUnreadCountCache(client, ASSISTANT_ID, 1);
    adjustUnreadCountCache(client, ASSISTANT_ID, 1);
    adjustUnreadCountCache(client, ASSISTANT_ID, 1);

    expect(read(client)).toBe(1);
  });

  test("no-ops when the count is unavailable", () => {
    // `null` means the assistant does not serve the endpoint. Writing a
    // number here would fabricate a count the server never produced.
    const client = seededClient(null);

    expect(adjustUnreadCountCache(client, ASSISTANT_ID, -1)).toBe(false);
    expect(read(client)).toBeNull();
  });

  test("no-ops when the cache is empty", () => {
    const client = seededClient(undefined);

    expect(adjustUnreadCountCache(client, ASSISTANT_ID, -1)).toBe(false);
    expect(read(client)).toBeUndefined();
  });

  test("two adjustments compose, so concurrent mutations do not clobber each other", () => {
    const client = seededClient(5);

    adjustUnreadCountCache(client, ASSISTANT_ID, -1);
    adjustUnreadCountCache(client, ASSISTANT_ID, -1);
    // Reverting only the first leaves the second's effect intact.
    adjustUnreadCountCache(client, ASSISTANT_ID, 1);

    expect(read(client)).toBe(4);
  });
});
