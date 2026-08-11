/**
 * The sidebar section index fetcher: how it classifies responses.
 *
 * The index is read from `GET /v1/conversations/sections`. An assistant
 * without the route 404s it, and the client treats that as "unavailable"
 * (`null`) so the sidebar keeps deriving section existence from the loaded
 * list. Every other failure has to stay a real failure, or an auth/server
 * error would be silently indistinguishable from an old assistant.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";

import { client as daemonClient } from "@/generated/daemon/client.gen";
import { ApiError } from "@/utils/api-errors";
import { fetchSidebarSections } from "@/utils/conversation-list-fetchers";

const ASSISTANT_ID = "assistant-1";

const originalGet = daemonClient.get;

afterEach(() => {
  daemonClient.get = originalGet;
});

/** Stub the daemon transport with one response for the next GET. */
function stubResponse(opts: { status: number; body?: unknown }): void {
  daemonClient.get = mock(async () => {
    const ok = opts.status < 400;
    return {
      data: ok ? opts.body : null,
      error: ok ? null : { message: "boom" },
      response: new Response(JSON.stringify(opts.body ?? {}), {
        status: opts.status,
      }),
    };
  }) as typeof daemonClient.get;
}

/** Stub the daemon transport with a transport-level failure (no response). */
function stubNetworkFailure(): void {
  daemonClient.get = mock(async () => ({
    data: null,
    error: new Error("network down"),
    response: undefined,
  })) as unknown as typeof daemonClient.get;
}

describe("fetchSidebarSections", () => {
  test("returns the sections from a successful response", async () => {
    const sections = [
      { kind: "pinned", total: 2, unread: 1 },
      { kind: "chats", total: 5, unread: 0 },
    ];
    stubResponse({ status: 200, body: { sections } });

    expect(await fetchSidebarSections(ASSISTANT_ID)).toEqual(
      sections as Awaited<ReturnType<typeof fetchSidebarSections>>,
    );
  });

  test("maps 404 to null so an assistant without the route reads as unavailable", async () => {
    stubResponse({ status: 404 });

    expect(await fetchSidebarSections(ASSISTANT_ID)).toBeNull();
  });

  test("throws a status-carrying ApiError on auth failure", async () => {
    // A 401 must not read as "old assistant": the sidebar would silently
    // stay on derived discovery while every other query surfaced the error.
    stubResponse({ status: 401 });

    await expect(fetchSidebarSections(ASSISTANT_ID)).rejects.toBeInstanceOf(
      ApiError,
    );
  });

  test("rethrows a transport failure raw so it retries as transient", async () => {
    stubNetworkFailure();

    await expect(fetchSidebarSections(ASSISTANT_ID)).rejects.not.toBeInstanceOf(
      ApiError,
    );
  });
});
