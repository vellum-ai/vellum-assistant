import { describe, it, expect, beforeEach, mock } from "bun:test";

type FetchFn = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;
let fetchMock: ReturnType<typeof mock<FetchFn>> = mock(
  async () => new Response(),
);

mock.module("../fetch.js", () => ({
  fetchImpl: (...args: Parameters<FetchFn>) => fetchMock(...args),
}));

const { fetchThreadContext } = await import("./thread-context.js");
const { clearUserInfoCache, clearInFlightFetches } =
  await import("./normalize.js");

function mockSlackApi(
  threadMessages: Array<{
    user?: string;
    text?: string;
    ts?: string;
    bot_id?: string;
    username?: string;
  }>,
  userNames: Record<string, string> = {},
) {
  fetchMock = mock(async (url: string | URL | Request) => {
    const urlStr = typeof url === "string" ? url : url.toString();
    if (urlStr.includes("conversations.replies")) {
      return Response.json({ ok: true, messages: threadMessages });
    }
    if (urlStr.includes("users.info")) {
      const userId = new URL(urlStr).searchParams.get("user");
      const name = userNames[userId!] ?? userId;
      return Response.json({
        ok: true,
        user: { name: userId, profile: { display_name: name } },
      });
    }
    return Response.json({ ok: false });
  });
}

describe("fetchThreadContext", () => {
  beforeEach(() => {
    clearUserInfoCache();
    clearInFlightFetches();
  });

  it("returns formatted context for a thread with parent and replies", async () => {
    mockSlackApi(
      [
        { user: "U001", text: "What should we work on today?", ts: "1000.0" },
        { user: "U002", text: "Let's fix the login bug", ts: "1000.1" },
        { user: "U001", text: "Sounds good, on it!", ts: "1000.2" },
      ],
      { U001: "Alice", U002: "Bob" },
    );

    const result = await fetchThreadContext(
      "C123",
      "1000.0",
      "1000.3", // current message ts, excluded from context
      "xoxb-test-token",
    );

    expect(result).toContain("reply in a Slack thread (3 prior messages)");
    expect(result).toContain("[Alice]: What should we work on today?");
    expect(result).toContain("[Bob]: Let's fix the login bug");
    expect(result).toContain("[Alice]: Sounds good, on it!");
  });

  it("returns parent-only context when thread has just one message", async () => {
    mockSlackApi(
      [{ user: "U001", text: "Check out this dashboard", ts: "1000.0" }],
      { U001: "Alice" },
    );

    const result = await fetchThreadContext(
      "C123",
      "1000.0",
      "1000.1",
      "xoxb-test-token",
    );

    expect(result).toContain("reply to the following Slack message");
    expect(result).toContain("[Alice]: Check out this dashboard");
  });

  it("labels bot messages as Assistant", async () => {
    mockSlackApi(
      [
        { user: "U001", text: "Help me with this", ts: "1000.0" },
        {
          user: "UBOT",
          text: "Sure, let me look into it",
          ts: "1000.1",
          bot_id: "B123",
        },
      ],
      { U001: "Alice" },
    );

    const result = await fetchThreadContext(
      "C123",
      "1000.0",
      "1000.2",
      "xoxb-test-token",
      "UBOT",
    );

    expect(result).toContain("[Alice]: Help me with this");
    expect(result).toContain("[Assistant]: Sure, let me look into it");
  });

  it("also labels messages by botUserId (without bot_id field) as Assistant", async () => {
    mockSlackApi(
      [
        { user: "U001", text: "Hey bot", ts: "1000.0" },
        { user: "UBOT", text: "Hello!", ts: "1000.1" },
      ],
      { U001: "Alice" },
    );

    const result = await fetchThreadContext(
      "C123",
      "1000.0",
      "1000.2",
      "xoxb-test-token",
      "UBOT",
    );

    expect(result).toContain("[Assistant]: Hello!");
  });

  it("excludes the current message from context", async () => {
    mockSlackApi(
      [
        { user: "U001", text: "Parent message", ts: "1000.0" },
        { user: "U002", text: "This is the current reply", ts: "1000.1" },
      ],
      { U001: "Alice", U002: "Bob" },
    );

    const result = await fetchThreadContext(
      "C123",
      "1000.0",
      "1000.1", // matches second message — should be excluded
      "xoxb-test-token",
    );

    expect(result).toContain("reply to the following Slack message");
    expect(result).toContain("[Alice]: Parent message");
    expect(result).not.toContain("This is the current reply");
  });

  it("returns null when API returns error", async () => {
    fetchMock = mock(async () =>
      Response.json({ ok: false, error: "channel_not_found" }),
    );

    const result = await fetchThreadContext(
      "C123",
      "1000.0",
      "1000.1",
      "xoxb-test-token",
    );

    expect(result).toBeNull();
  });

  it("returns null when all messages are excluded", async () => {
    mockSlackApi([{ user: "U001", text: "Only message", ts: "1000.0" }]);

    const result = await fetchThreadContext(
      "C123",
      "1000.0",
      "1000.0", // matches the only message
      "xoxb-test-token",
    );

    expect(result).toBeNull();
  });

  it("returns null on HTTP error", async () => {
    fetchMock = mock(async () => new Response("Server Error", { status: 500 }));

    const result = await fetchThreadContext(
      "C123",
      "1000.0",
      "1000.1",
      "xoxb-test-token",
    );

    expect(result).toBeNull();
  });
});
