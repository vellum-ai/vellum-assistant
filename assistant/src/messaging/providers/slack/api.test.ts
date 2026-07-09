import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";

const BOT_TOKEN = "xoxb-test";

mock.module("../../../security/secure-keys.js", () => ({
  getSecureKeyAsync: async () => BOT_TOKEN,
}));

const { appendSlackStream, getSlackConversationInfo, startSlackStream } =
  await import("./api.js");

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

  test("serializes the plan title and tasks as chunks", async () => {
    const body = mockStartStream();

    await startSlackStream({
      channel: "D123",
      threadTs: "1700.0",
      markdownText: "hi",
      taskDisplayMode: "plan",
      planTitle: "Quick Briefing",
      tasks: [
        {
          id: "task-0",
          title: "Check weather",
          status: "in_progress",
          details: "Fetching the forecast",
        },
        { id: "task-1", title: "Summarize", status: "pending" },
      ],
    });

    expect(body()).toMatchObject({
      task_display_mode: "plan",
      chunks: [
        { type: "plan_update", title: "Quick Briefing" },
        {
          type: "task_update",
          id: "task-0",
          title: "Check weather",
          status: "in_progress",
          details: "Fetching the forecast",
        },
        {
          type: "task_update",
          id: "task-1",
          title: "Summarize",
          status: "pending",
        },
      ],
    });
  });

  test("caps chunk string fields at Slack's 256-character limit", async () => {
    const body = mockStartStream();

    await startSlackStream({
      channel: "D123",
      threadTs: "1700.0",
      markdownText: "hi",
      planTitle: "t".repeat(300),
      tasks: [
        {
          id: "task-0",
          title: "a".repeat(300),
          status: "in_progress",
          details: "b".repeat(300),
        },
      ],
    });

    const chunks = body().chunks as Array<Record<string, unknown>>;
    expect((chunks[0].title as string).length).toBe(256);
    expect((chunks[1].title as string).length).toBe(256);
    expect((chunks[1].details as string).length).toBe(256);
  });
});

describe("appendSlackStream", () => {
  test("sends a chunks-only append when no markdown text is given", async () => {
    let capturedBody: Record<string, unknown> = {};
    globalThis.fetch = mock(async (_input, init) => {
      capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    await appendSlackStream({
      channel: "D123",
      streamTs: "1700.1",
      tasks: [{ id: "task-0", title: "Check weather", status: "complete" }],
    });

    expect(capturedBody).not.toHaveProperty("markdown_text");
    expect(capturedBody.chunks).toEqual([
      {
        type: "task_update",
        id: "task-0",
        title: "Check weather",
        status: "complete",
      },
    ]);
  });
});
