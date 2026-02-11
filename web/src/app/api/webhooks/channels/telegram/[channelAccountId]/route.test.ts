import { describe, expect, test, mock, beforeEach } from "bun:test";

let webhookResolved = false;

mock.module("@/lib/channels/service", () => ({
  handleTelegramWebhook: async () => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    webhookResolved = true;
    return { status: "ok" };
  },
}));

mock.module("next/server", () => ({
  NextRequest: globalThis.Request,
  NextResponse: {
    json: (body: unknown, init?: ResponseInit) =>
      new Response(JSON.stringify(body), {
        ...init,
        headers: { "content-type": "application/json" },
      }),
  },
  after: (callback: () => void) => {
    // Simulate Next.js after(): fires callback after the response is sent
    Promise.resolve().then(() => callback());
  },
}));

const { POST } = await import("./route");

describe("Telegram webhook route", () => {
  beforeEach(() => {
    webhookResolved = false;
  });

  test("returns 200 immediately without waiting for webhook processing", async () => {
    const request = new Request(
      "http://localhost/api/webhooks/channels/telegram/test-account-id",
      {
        method: "POST",
        body: JSON.stringify({
          update_id: 12345,
          message: {
            message_id: 1,
            chat: { id: 100, type: "private" },
            from: { id: 200, is_bot: false, first_name: "Test" },
            text: "hello",
            date: 1234567890,
          },
        }),
        headers: { "content-type": "application/json" },
      },
    );

    const response = await POST(request as unknown as Parameters<typeof POST>[0], {
      params: Promise.resolve({ channelAccountId: "test-account-id" }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);

    // webhook processing should NOT have completed yet.
    // With after(): response returns before processing finishes → false ✓
    // Without after() (await): response waits for processing → true ✗
    expect(webhookResolved).toBe(false);
  });
});
