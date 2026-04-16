/**
 * Focused tests for the `POST /send_chat` HTTP endpoint.
 *
 * The general HTTP server suite in `http-server.test.ts` covers auth and
 * validation at a high level; this file exercises the full matrix for
 * `/send_chat` specifically — auth, body validation, the 2000-character
 * Meet chat limit, the Playwright failure path (502), and the happy path
 * (200). The `sendChat` helper from `chat-bridge.ts` is mocked via the
 * `onSendChat` callback so no browser is required.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  createHttpServer,
  type HttpServerHandle,
} from "../src/control/http-server.js";
import { BotState } from "../src/control/state.js";

const API_TOKEN = "test-send-chat-token";

interface SendChatHarness {
  server: HttpServerHandle;
  receivedText: string[];
  /** When set, the next `onSendChat` call rejects with this error. */
  failNextWith: { error: Error | null };
}

function makeServer(): SendChatHarness {
  const receivedText: string[] = [];
  const failNextWith: { error: Error | null } = { error: null };
  const server = createHttpServer({
    apiToken: API_TOKEN,
    onLeave: () => {},
    onSendChat: async (text) => {
      receivedText.push(text);
      if (failNextWith.error) {
        const err = failNextWith.error;
        failNextWith.error = null;
        throw err;
      }
    },
    onPlayAudio: () => {},
  });
  return { server, receivedText, failNextWith };
}

async function startOnRandomPort(server: HttpServerHandle): Promise<string> {
  const { port } = await server.start(0);
  return `http://127.0.0.1:${port}`;
}

async function postSendChat(
  base: string,
  body: unknown,
  opts: { auth?: string | null } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (opts.auth === undefined) {
    headers.authorization = `Bearer ${API_TOKEN}`;
  } else if (opts.auth !== null) {
    headers.authorization = opts.auth;
  }
  return fetch(`${base}/send_chat`, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("POST /send_chat endpoint", () => {
  let server: HttpServerHandle | null = null;

  beforeEach(() => {
    BotState.__resetForTests();
  });

  afterEach(async () => {
    if (server !== null) {
      await server.stop();
      server = null;
    }
  });

  // -------------------------------------------------------------------------
  // auth
  // -------------------------------------------------------------------------

  test("rejects a request with no authorization header", async () => {
    const harness = makeServer();
    server = harness.server;
    const base = await startOnRandomPort(server);

    const res = await postSendChat(
      base,
      { type: "send_chat", text: "hello" },
      { auth: null },
    );
    expect(res.status).toBe(401);
    expect(harness.receivedText).toEqual([]);
  });

  test("rejects a request with the wrong bearer token", async () => {
    const harness = makeServer();
    server = harness.server;
    const base = await startOnRandomPort(server);

    const res = await postSendChat(
      base,
      { type: "send_chat", text: "hello" },
      { auth: "Bearer wrong-token" },
    );
    expect(res.status).toBe(401);
    expect(harness.receivedText).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // body validation
  // -------------------------------------------------------------------------

  test("rejects a body with the wrong type discriminator with 400", async () => {
    const harness = makeServer();
    server = harness.server;
    const base = await startOnRandomPort(server);

    const res = await postSendChat(base, { type: "leave", text: "hi" });
    expect(res.status).toBe(400);
    expect(harness.receivedText).toEqual([]);
  });

  test("rejects an empty text with 400", async () => {
    const harness = makeServer();
    server = harness.server;
    const base = await startOnRandomPort(server);

    const res = await postSendChat(base, { type: "send_chat", text: "" });
    expect(res.status).toBe(400);
    expect(harness.receivedText).toEqual([]);
  });

  test("rejects a non-JSON body with 400", async () => {
    const harness = makeServer();
    server = harness.server;
    const base = await startOnRandomPort(server);

    const res = await postSendChat(base, "not json at all");
    expect(res.status).toBe(400);
    expect(harness.receivedText).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // 2000-char limit
  // -------------------------------------------------------------------------

  test("accepts a message of exactly 2000 characters", async () => {
    const harness = makeServer();
    server = harness.server;
    const base = await startOnRandomPort(server);

    const text = "a".repeat(2000);
    const res = await postSendChat(base, { type: "send_chat", text });
    expect(res.status).toBe(200);
    expect(harness.receivedText).toEqual([text]);
  });

  test("rejects a message of 2001 characters with 400", async () => {
    const harness = makeServer();
    server = harness.server;
    const base = await startOnRandomPort(server);

    const text = "b".repeat(2001);
    const res = await postSendChat(base, { type: "send_chat", text });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; length: number };
    expect(body.error).toContain("2000");
    expect(body.length).toBe(2001);
    expect(harness.receivedText).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // happy path
  // -------------------------------------------------------------------------

  test("returns 200 and passes text through to sendChat unchanged", async () => {
    const harness = makeServer();
    server = harness.server;
    const base = await startOnRandomPort(server);

    const text = "hello from the bot — special chars: \u2603 🎉";
    const res = await postSendChat(base, { type: "send_chat", text });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sent: boolean; timestamp: string };
    expect(body.sent).toBe(true);
    expect(typeof body.timestamp).toBe("string");
    // Timestamp should parse as a valid ISO date.
    expect(Number.isNaN(Date.parse(body.timestamp))).toBe(false);
    expect(harness.receivedText).toEqual([text]);
  });

  // -------------------------------------------------------------------------
  // Playwright failure path
  // -------------------------------------------------------------------------

  test("returns 502 when sendChat throws (Playwright selector failure)", async () => {
    const harness = makeServer();
    server = harness.server;
    const base = await startOnRandomPort(server);

    harness.failNextWith.error = new Error(
      "Timeout 10000ms exceeded waiting for selector",
    );

    const res = await postSendChat(base, {
      type: "send_chat",
      text: "will fail",
    });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { sent: boolean; error: string };
    expect(body.sent).toBe(false);
    expect(body.error).toContain("Timeout");
    // The handler was invoked before it threw.
    expect(harness.receivedText).toEqual(["will fail"]);
  });

  test("returns 502 when sendChat rejects with a non-Error value", async () => {
    const harness = makeServer();
    server = harness.server;
    const base = await startOnRandomPort(server);

    // Force a non-Error throw. `Error` is the shape our code path expects,
    // but Playwright and other libs have been known to throw plain objects,
    // so we verify the stringify fallback behaves.
    harness.failNextWith.error = { toString: () => "weird-failure" } as Error;

    const res = await postSendChat(base, {
      type: "send_chat",
      text: "will fail",
    });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { sent: boolean; error: string };
    expect(body.sent).toBe(false);
    expect(body.error).toBe("weird-failure");
  });
});
