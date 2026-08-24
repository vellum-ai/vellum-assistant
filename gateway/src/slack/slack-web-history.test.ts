import { describe, expect, mock, test } from "bun:test";

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

const { fetchChannelHistorySince } = await import("./slack-web.js");

function historyResponse(messages: unknown[]): Response {
  return new Response(JSON.stringify({ ok: true, messages }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const params = {
  botToken: "xoxb-test",
  channel: "C1",
  oldest: "1700000000.000000",
  limit: 50,
};

describe("recovered history messages are validated, not asserted", () => {
  test("a file keeps the same checked shape a live event's does", async () => {
    fetchMock = mock(async () =>
      historyResponse([
        {
          type: "message",
          user: "U1",
          text: "here",
          ts: "1700000001.000000",
          files: [{ id: "F1", name: "a.png", mimetype: "image/png" }],
        },
      ]),
    );

    const result = await fetchChannelHistorySince(params);

    expect(result.messages).toHaveLength(1);
    // Reaching `id` without a cast is the point: a recovered file carries the
    // checked shape, so the catch-up path can build an event from it directly.
    expect(result.messages[0]?.files?.[0]?.id).toBe("F1");
  });

  test("a malformed message is dropped without taking the page with it", async () => {
    // Tolerance is per message on purpose. The alternative to dropping one
    // unparseable message is dropping every message recovered in that page,
    // and a message lost after a reconnect is one the user never sees.
    fetchMock = mock(async () =>
      historyResponse([
        { type: "message", user: "U1", text: "kept", ts: "1700000001.000000" },
        { type: "message", user: "U2", text: "no ts" },
        {
          type: "message",
          user: "U3",
          text: "also kept",
          ts: "1700000002.000000",
        },
      ]),
    );

    const result = await fetchChannelHistorySince(params);

    expect(result.messages.map((m) => m.text)).toEqual(["kept", "also kept"]);
  });

  test("a file missing its id is coerced the same way a live event's is", async () => {
    // `slackFileSchema` declares `id` as required and catches to `""`, so a
    // malformed file is forwarded with an empty id rather than discarded.
    // Asserted here to hold the recovered path identical to the live one:
    // making history stricter would reintroduce the divergence this change
    // exists to remove. Whether `""` is the right coercion is a question about
    // that shared schema, not about catch-up.
    fetchMock = mock(async () =>
      historyResponse([
        {
          type: "message",
          user: "U1",
          text: "text plus a bad file",
          ts: "1700000001.000000",
          files: [{ name: "no id" }],
        },
      ]),
    );

    const result = await fetchChannelHistorySince(params);

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.text).toBe("text plus a bad file");
    expect(result.messages[0]?.files?.[0]?.id).toBe("");
  });
});
