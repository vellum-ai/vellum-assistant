/**
 * Observed-kind cache for Slack conversations (LUM-2935).
 *
 * Reaction payloads carry no `channel_type`, so group-DM admission depends on
 * what the gateway learned from earlier events plus a `conversations.info`
 * fallback. The subtle requirement pinned here: the reconnect replay path
 * *synthesizes* a `channel_type` for `conversations.history` messages and
 * falls back to `"channel"`, so that value must never be treated as evidence.
 */
import { describe, test, expect, mock, beforeEach } from "bun:test";

type FetchFn = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

let fetchMock: ReturnType<typeof mock<FetchFn>> = mock(
  async () => new Response(),
);
const fetchedUrls: string[] = [];

mock.module("../fetch.js", () => ({
  fetchImpl: (...args: Parameters<FetchFn>) => {
    fetchedUrls.push(String(args[0]));
    return fetchMock(...args);
  },
}));

const {
  recordSlackChannelKind,
  resolveSlackChannelKind,
  isKnownSlackMpimSync,
  clearChannelInfoCache,
  clearInFlightFetches,
} = await import("../slack/user-directory.js");

const TOKEN = "xoxb-test";
const MPIM = "C0000000MP1";

function conversationsInfoResponse(isMpim: boolean): Response {
  return new Response(
    JSON.stringify({
      ok: true,
      channel: { name: "mpdm-group-dm-1", is_mpim: isMpim },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

beforeEach(() => {
  clearChannelInfoCache();
  clearInFlightFetches();
  fetchedUrls.length = 0;
  fetchMock = mock(async () => conversationsInfoResponse(true));
});

describe("Slack observed channel-kind cache", () => {
  test("learns a group DM from a message event's channel_type", () => {
    recordSlackChannelKind(MPIM, TOKEN, "mpim");
    expect(isKnownSlackMpimSync(MPIM, TOKEN)).toBe(true);
    // Answered from cache, no API call needed.
    expect(fetchedUrls).toHaveLength(0);
  });

  test("learns a non-group DM from an im channel_type", () => {
    recordSlackChannelKind("D0123ABCD", TOKEN, "im");
    expect(isKnownSlackMpimSync("D0123ABCD", TOKEN)).toBe(false);
    expect(fetchedUrls).toHaveLength(0);
  });

  test("ignores a synthesized 'channel' value rather than caching a guess", async () => {
    // The replay path stamps "channel" for any history message it cannot
    // classify. If that were recorded, a replayed MPIM would cache
    // `isMpim: false` and re-break admission for the whole TTL.
    recordSlackChannelKind(MPIM, TOKEN, "channel");
    recordSlackChannelKind(MPIM, TOKEN, "group");

    // Nothing was learned, so the authoritative lookup still runs and wins.
    const kind = await resolveSlackChannelKind(MPIM, TOKEN);
    expect(kind?.isMpim).toBe(true);
    expect(isKnownSlackMpimSync(MPIM, TOKEN)).toBe(true);
  });

  test("a real 'mpim' observation survives a later synthesized 'channel'", () => {
    recordSlackChannelKind(MPIM, TOKEN, "mpim");
    recordSlackChannelKind(MPIM, TOKEN, "channel");
    expect(isKnownSlackMpimSync(MPIM, TOKEN)).toBe(true);
  });

  test("resolves an unknown channel through conversations.info and caches it", async () => {
    const kind = await resolveSlackChannelKind(MPIM, TOKEN);
    expect(kind?.isMpim).toBe(true);
    expect(fetchedUrls).toHaveLength(1);
    expect(fetchedUrls[0]).toContain("conversations.info");

    // Second read is served from cache.
    await resolveSlackChannelKind(MPIM, TOKEN);
    expect(fetchedUrls).toHaveLength(1);
  });

  test("caches the negative result so ordinary channels stop re-fetching", async () => {
    fetchMock = mock(async () => conversationsInfoResponse(false));
    const kind = await resolveSlackChannelKind("C-ordinary", TOKEN);
    expect(kind?.isMpim).toBe(false);

    expect(isKnownSlackMpimSync("C-ordinary", TOKEN)).toBe(false);
    expect(fetchedUrls).toHaveLength(1);
  });

  test("sync miss reports false and warms the cache in the background", async () => {
    expect(isKnownSlackMpimSync(MPIM, TOKEN)).toBe(false);

    // The background warm settles, and the next read is correct. This is the
    // documented cold-start gap: the first event in a never-seen MPIM can
    // still be dropped.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(isKnownSlackMpimSync(MPIM, TOKEN)).toBe(true);
  });

  test("treats an unresolvable channel as not a group DM", async () => {
    fetchMock = mock(async () => new Response("nope", { status: 500 }));
    const kind = await resolveSlackChannelKind("C0000000BR1", TOKEN);
    expect(kind).toBeUndefined();
    // Fail closed: a Slack outage must not widen admission.
    expect(isKnownSlackMpimSync("C0000000BR1", TOKEN)).toBe(false);
  });

  test("backs off after a failed lookup instead of re-fetching every event", async () => {
    fetchMock = mock(async () => new Response("rate limited", { status: 429 }));
    await resolveSlackChannelKind("C0000000RL1", TOKEN);
    expect(fetchedUrls).toHaveLength(1);

    // Admission runs per event. Without a cached failure marker each of these
    // would re-fire a warm, and under a 429 that loop is self-sustaining.
    for (let i = 0; i < 5; i++) {
      expect(isKnownSlackMpimSync("C0000000RL1", TOKEN)).toBe(false);
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchedUrls).toHaveLength(1);
  });

  test("a later channel_type observation overrides a failure marker", async () => {
    fetchMock = mock(async () => new Response("nope", { status: 500 }));
    await resolveSlackChannelKind(MPIM, TOKEN);
    expect(isKnownSlackMpimSync(MPIM, TOKEN)).toBe(false);

    recordSlackChannelKind(MPIM, TOKEN, "mpim");
    expect(isKnownSlackMpimSync(MPIM, TOKEN)).toBe(true);
  });
});
