import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";

const BOT_TOKEN = "xoxb-test";

mock.module("../../../security/secure-keys.js", () => ({
  getSecureKeyAsync: async () => BOT_TOKEN,
}));

const { getSlackConversationInfo } = await import("./api.js");

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
