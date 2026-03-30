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

const { fetchDmContext } = await import("./dm-context.js");
const { clearUserInfoCache, clearInFlightFetches } =
  await import("./normalize.js");

function mockSlackApi(
  historyMessages: Array<{
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
    if (urlStr.includes("conversations.history")) {
      return Response.json({ ok: true, messages: historyMessages });
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

describe("fetchDmContext", () => {
  beforeEach(() => {
    clearUserInfoCache();
    clearInFlightFetches();
  });

  it("returns formatted context with prior messages", async () => {
    // Slack returns newest-first; include a bot message
    mockSlackApi(
      [
        {
          user: "UBOT",
          text: "Here's what I found",
          ts: "1000.2",
          bot_id: "B123",
        },
        { user: "U001", text: "Can you look this up?", ts: "1000.1" },
        { user: "U001", text: "Hey there", ts: "1000.0" },
      ],
      { U001: "Alice", UBOT: "Assistant" },
    );

    const result = await fetchDmContext(
      "D123",
      "1000.3", // current message ts, excluded from context
      "xoxb-test-token",
    );

    expect(result).toContain(
      "Recent messages in this DM conversation (3 prior messages)",
    );
    // Should be in chronological order (oldest first)
    const aliceHeyIdx = result!.indexOf("[Alice]: Hey there");
    const aliceCanIdx = result!.indexOf("[Alice]: Can you look this up?");
    const botIdx = result!.indexOf("[Assistant]: Here's what I found");
    expect(aliceHeyIdx).toBeLessThan(aliceCanIdx);
    expect(aliceCanIdx).toBeLessThan(botIdx);
  });

  it("excludes the current message", async () => {
    mockSlackApi(
      [
        { user: "U001", text: "This is the current message", ts: "1000.1" },
        { user: "U002", text: "Earlier message", ts: "1000.0" },
      ],
      { U001: "Alice", U002: "Bob" },
    );

    const result = await fetchDmContext(
      "D123",
      "1000.1", // matches first message — should be excluded
      "xoxb-test-token",
    );

    expect(result).toContain("1 prior messages");
    expect(result).toContain("[Bob]: Earlier message");
    expect(result).not.toContain("This is the current message");
  });

  it("returns null when no prior messages", async () => {
    // Only the current message in history
    mockSlackApi([
      { user: "U001", text: "Hello!", ts: "1000.0" },
    ]);

    const result = await fetchDmContext(
      "D123",
      "1000.0", // matches the only message
      "xoxb-test-token",
    );

    expect(result).toBeNull();
  });

  it("returns null on API error", async () => {
    fetchMock = mock(async () =>
      Response.json({ ok: false, error: "channel_not_found" }),
    );

    const result = await fetchDmContext(
      "D123",
      "1000.0",
      "xoxb-test-token",
    );

    expect(result).toBeNull();
  });

  it("returns null on HTTP error", async () => {
    fetchMock = mock(async () => new Response("Server Error", { status: 500 }));

    const result = await fetchDmContext(
      "D123",
      "1000.0",
      "xoxb-test-token",
    );

    expect(result).toBeNull();
  });

  it("reverses API order to chronological", async () => {
    // Slack API returns newest-first
    mockSlackApi(
      [
        { user: "U001", text: "Third message", ts: "1000.2" },
        { user: "U001", text: "Second message", ts: "1000.1" },
        { user: "U001", text: "First message", ts: "1000.0" },
      ],
      { U001: "Alice" },
    );

    const result = await fetchDmContext(
      "D123",
      "9999.0", // current message not in list
      "xoxb-test-token",
    );

    // Verify chronological order in output
    const firstIdx = result!.indexOf("First message");
    const secondIdx = result!.indexOf("Second message");
    const thirdIdx = result!.indexOf("Third message");
    expect(firstIdx).toBeLessThan(secondIdx);
    expect(secondIdx).toBeLessThan(thirdIdx);
  });
});
