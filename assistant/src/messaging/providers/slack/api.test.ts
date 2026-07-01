import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";

const BOT_TOKEN = "xoxb-test";

mock.module("../../../security/secure-keys.js", () => ({
  getSecureKeyAsync: async () => BOT_TOKEN,
}));

const { getSlackConversationInfo, startSlackStream } = await import("./api.js");

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

afterAll(() => {
  mock.restore();
});

describe("getSlackConversationInfo", () => {
  test("calls conversations.info with GET query params", async () => {
    let capturedUrl: string | undefined;
    let capturedInit: RequestInit | undefined;

    globalThis.fetch = mock(async (input, init) => {
      capturedUrl = String(input);
      capturedInit = init;
      return new Response(
        JSON.stringify({
          ok: true,
          channel: {
            id: "C123",
            name: "engineering",
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const info = await getSlackConversationInfo("C123");

    expect(info).toEqual({ id: "C123", name: "engineering" });
    expect(capturedUrl).toBeDefined();
    const url = new URL(capturedUrl!);
    expect(url.pathname).toBe("/api/conversations.info");
    expect(url.searchParams.get("channel")).toBe("C123");
    expect(capturedInit?.method).toBe("GET");
    expect(capturedInit?.body).toBeUndefined();
    expect(capturedInit?.headers).toEqual({
      Authorization: `Bearer ${BOT_TOKEN}`,
    });
  });
});

describe("startSlackStream", () => {
  function mockStartStream(): () => Record<string, unknown> {
    let capturedBody: Record<string, unknown> = {};
    globalThis.fetch = mock(async (_input, init) => {
      capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ ok: true, ts: "1700.1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    return () => capturedBody;
  }

  test("sets recipient fields when streaming into a channel", async () => {
    const body = mockStartStream();

    await startSlackStream({
      channel: "C123",
      threadTs: "1700.0",
      markdownText: "hi",
      recipientUserId: "U123",
      recipientTeamId: "T123",
    });

    expect(body()).toMatchObject({
      channel: "C123",
      thread_ts: "1700.0",
      markdown_text: "hi",
      recipient_user_id: "U123",
      recipient_team_id: "T123",
    });
  });

  test("omits recipient fields for a DM stream", async () => {
    const body = mockStartStream();

    await startSlackStream({
      channel: "D123",
      threadTs: "1700.0",
      markdownText: "hi",
    });

    const sent = body();
    expect(sent).not.toHaveProperty("recipient_user_id");
    expect(sent).not.toHaveProperty("recipient_team_id");
  });
});
