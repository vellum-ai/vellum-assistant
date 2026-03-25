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

  it("resolves all authors by display name including bots", async () => {
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
      { U001: "Alice", UBOT: "Pax" },
    );

    const result = await fetchThreadContext(
      "C123",
      "1000.0",
      "1000.2",
      "xoxb-test-token",
    );

    expect(result).toContain("[Alice]: Help me with this");
    expect(result).toContain("[Pax]: Sure, let me look into it");
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

  it("keeps parent + most recent replies for long threads", async () => {
    // Simulate a thread with 20 messages (parent + 19 replies)
    const messages = Array.from({ length: 20 }, (_, i) => ({
      user: "U001",
      text: `Message ${i}`,
      ts: `1000.${i}`,
    }));
    mockSlackApi(messages, { U001: "Alice" });

    const result = await fetchThreadContext(
      "C123",
      "1000.0",
      "9999.0", // current message not in the list
      "xoxb-test-token",
    );

    // Should include the parent (Message 0) and the 14 most recent
    expect(result).toContain("[Alice]: Message 0\n");
    // Middle messages (1-5) should be trimmed
    expect(result).not.toContain("Message 1\n");
    expect(result).not.toContain("Message 5\n");
    // Recent messages should be present
    expect(result).toContain("[Alice]: Message 19");
    expect(result).toContain("[Alice]: Message 6\n");
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
