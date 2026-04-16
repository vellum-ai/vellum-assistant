/**
 * Daemon-side chat-send E2E test.
 *
 * Stands up a real `Bun.serve` HTTP endpoint on a random loopback port to
 * play the role of the meet-bot container, drives `MeetSessionManager`
 * through a full `join()` → `sendChat()` cycle against that fake bot, and
 * asserts both the HTTP wire payload (body + auth header) and the
 * `meet.chat_sent` event that lands on `assistantEventHub`.
 *
 * What the test exercises end-to-end:
 *
 *   1. `MeetSessionManager.sendChat` looks up the active session, formats
 *      the request body as `{ type: "send_chat", text }`, and attaches
 *      the per-meeting bearer token. The default `botSendChatFetch` is
 *      NOT overridden, so this is a real `fetch()` call against a real
 *      HTTP server on the loopback interface.
 *
 *   2. The fake bot server records the request and responds 200, so the
 *      happy path produces no domain error.
 *
 *   3. `publishMeetEvent(..., "meet.chat_sent", { text })` lands on the
 *      shared `assistantEventHub` with the expected payload. The
 *      subscriber sees the event exactly once.
 *
 *   4. Domain errors surface correctly:
 *        - Unknown meetingId → `MeetSessionNotFoundError`.
 *        - Bot returns a non-2xx → `MeetBotChatError` whose `status`
 *          matches the response.
 *        - Bot unreachable (server torn down before the call) →
 *          `MeetSessionUnreachableError`.
 *
 * The test does not spin up real Docker, no real Meet, and does not
 * touch the daemon's long-running singletons directly — it uses
 * `_createMeetSessionManagerForTests` so each test gets its own isolated
 * manager with mock docker / audio-ingest deps. The Docker `run` result
 * is stitched to the real bound port of the fake bot server so the
 * session's `botBaseUrl` actually points at something we can serve a
 * response from.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { AssistantEvent } from "../../../../assistant/src/runtime/assistant-event.js";
import { assistantEventHub } from "../../../../assistant/src/runtime/assistant-event-hub.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "../../../../assistant/src/runtime/assistant-scope.js";
import { meetEventDispatcher } from "../event-publisher.js";
import { __resetMeetSessionEventRouterForTests } from "../session-event-router.js";
import {
  _createMeetSessionManagerForTests,
  MEET_BOT_INTERNAL_PORT,
  MeetBotChatError,
  MeetSessionNotFoundError,
  MeetSessionUnreachableError,
  type MeetAudioIngestLike,
} from "../session-manager.js";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

interface RecordedRequest {
  method: string;
  url: string;
  authorization: string | null;
  contentType: string | null;
  body: string;
}

interface FakeBotServer {
  url: string;
  port: number;
  requests: RecordedRequest[];
  /** Override the next response status/body — resets back to default after use. */
  setNextResponse: (status: number, body?: unknown) => void;
  stop: () => Promise<void>;
}

/**
 * Boot a throwaway `Bun.serve` on a random loopback port that records
 * every request it receives for later assertion. Default behavior is to
 * return `200 { sent: true, timestamp }`, mirroring the meet-bot's real
 * `/send_chat` contract; individual tests can override the next response
 * via `setNextResponse`.
 */
function startFakeBot(): FakeBotServer {
  const requests: RecordedRequest[] = [];
  let nextResponse: { status: number; body?: unknown } | null = null;

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (req) => {
      const body = await req.text().catch(() => "");
      requests.push({
        method: req.method,
        url: new URL(req.url).pathname,
        authorization: req.headers.get("authorization"),
        contentType: req.headers.get("content-type"),
        body,
      });
      if (nextResponse) {
        const { status, body: responseBody } = nextResponse;
        nextResponse = null;
        return new Response(
          responseBody === undefined ? "" : JSON.stringify(responseBody),
          { status, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({ sent: true, timestamp: new Date().toISOString() }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });

  const port = server.port;
  if (port === undefined) {
    throw new Error("fake bot server failed to bind a port");
  }

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    requests,
    setNextResponse: (status, body) => {
      nextResponse = { status, body };
    },
    stop: async () => {
      await server.stop(true);
    },
  };
}

/**
 * Subscribe to the event hub for `DAEMON_INTERNAL_ASSISTANT_ID` (the
 * scope every Meet event publishes under) and collect every delivered
 * event. Callers should call `dispose()` in a `finally` so we don't leak
 * subscribers across tests.
 */
function captureHub(): {
  received: AssistantEvent[];
  dispose: () => void;
} {
  const received: AssistantEvent[] = [];
  const sub = assistantEventHub.subscribe(
    { assistantId: DAEMON_INTERNAL_ASSISTANT_ID },
    (event) => {
      received.push(event);
    },
  );
  return { received, dispose: () => sub.dispose() };
}

/**
 * Minimal stand-in for the audio ingest. The session manager doesn't
 * interact with it after `start()` resolves, so the fake is a no-op.
 */
function makeFakeAudioIngest(): MeetAudioIngestLike {
  return {
    start: async () => {},
    stop: async () => {},
    subscribePcm: () => () => {},
  };
}

/**
 * Build a mock Docker runner whose `run()` returns a container record
 * pinned to the real fake-bot server's host port. This is how we stitch
 * the session's `botBaseUrl` to something a real `fetch()` can hit.
 */
function makeMockRunnerPointingAt(fakeBot: FakeBotServer) {
  const runResult = {
    containerId: "container-chat-e2e",
    boundPorts: [
      {
        protocol: "tcp" as const,
        containerPort: MEET_BOT_INTERNAL_PORT,
        hostIp: "127.0.0.1",
        hostPort: fakeBot.port,
      },
    ],
  };
  return {
    run: mock(async () => runResult),
    stop: mock(async () => {}),
    remove: mock(async () => {}),
    inspect: mock(async () => ({ Id: runResult.containerId })),
    logs: mock(async () => ""),
  };
}

let workspaceDir: string;
let fakeBot: FakeBotServer;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "chat-send-e2e-"));
  __resetMeetSessionEventRouterForTests();
  meetEventDispatcher._resetForTests();
  fakeBot = startFakeBot();
});

afterEach(async () => {
  await fakeBot.stop();
  rmSync(workspaceDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Happy path — real HTTP, real event-hub
// ---------------------------------------------------------------------------

describe("MeetSessionManager.sendChat end-to-end (real HTTP + real event hub)", () => {
  test("forwards the message to the bot over HTTP and publishes meet.chat_sent", async () => {
    const runner = makeMockRunnerPointingAt(fakeBot);
    const { received, dispose } = captureHub();

    try {
      const manager = _createMeetSessionManagerForTests({
        dockerRunnerFactory: () => runner,
        getProviderKey: async () => "tts-key",
        getWorkspaceDir: () => workspaceDir,
        botLeaveFetch: async () => {},
        audioIngestFactory: makeFakeAudioIngest,
      });

      const session = await manager.join({
        url: "https://meet.google.com/abc-def-ghi",
        meetingId: "m-chat-e2e",
        conversationId: "conv-chat-e2e",
      });

      // Sanity: session is pointed at our fake bot.
      expect(session.botBaseUrl).toBe(fakeBot.url);

      const text = "hello";
      await manager.sendChat("m-chat-e2e", text);

      // ---- Assert: bot HTTP server received exactly one well-formed request.
      expect(fakeBot.requests).toHaveLength(1);
      const req = fakeBot.requests[0]!;
      expect(req.method).toBe("POST");
      expect(req.url).toBe("/send_chat");
      expect(req.authorization).toBe(`Bearer ${session.botApiToken}`);
      expect(req.contentType).toContain("application/json");
      const parsed = JSON.parse(req.body) as { type: string; text: string };
      expect(parsed.type).toBe("send_chat");
      expect(parsed.text).toBe(text);

      // ---- Assert: assistantEventHub received `meet.chat_sent` with the text.
      // publishMeetEvent is fire-and-forget inside sendChat, so give the
      // microtask queue a tick to flush before asserting.
      await Promise.resolve();
      await Promise.resolve();

      const chatSent = received.filter(
        (e) => e.message.type === "meet.chat_sent",
      );
      expect(chatSent).toHaveLength(1);
      const message = chatSent[0]!.message as {
        type: "meet.chat_sent";
        meetingId: string;
        text: string;
      };
      expect(message.meetingId).toBe("m-chat-e2e");
      expect(message.text).toBe(text);
      expect(chatSent[0]!.assistantId).toBe(DAEMON_INTERNAL_ASSISTANT_ID);

      await manager.leave("m-chat-e2e", "cleanup");
    } finally {
      dispose();
    }
  });

  test("preserves text with special characters in the JSON body", async () => {
    // Sanity that we don't accidentally double-encode or mangle unicode
    // on the way out. Uses a string with an emoji, non-ASCII punctuation,
    // and embedded quotes — all legitimate chat content.
    const runner = makeMockRunnerPointingAt(fakeBot);
    const { received, dispose } = captureHub();
    try {
      const manager = _createMeetSessionManagerForTests({
        dockerRunnerFactory: () => runner,
        getProviderKey: async () => "",
        getWorkspaceDir: () => workspaceDir,
        botLeaveFetch: async () => {},
        audioIngestFactory: makeFakeAudioIngest,
      });

      await manager.join({
        url: "u",
        meetingId: "m-chat-unicode",
        conversationId: "c",
      });

      const text = 'Hello — "quoted" 🎉 newlines\nare\tfine';
      await manager.sendChat("m-chat-unicode", text);

      expect(fakeBot.requests).toHaveLength(1);
      const parsed = JSON.parse(fakeBot.requests[0]!.body) as { text: string };
      expect(parsed.text).toBe(text);

      await Promise.resolve();
      await Promise.resolve();
      const chatSent = received.filter(
        (e) => e.message.type === "meet.chat_sent",
      );
      expect(chatSent).toHaveLength(1);
      expect((chatSent[0]!.message as { text: string }).text).toBe(text);

      await manager.leave("m-chat-unicode", "cleanup");
    } finally {
      dispose();
    }
  });

  test("throws MeetSessionNotFoundError and does NOT publish meet.chat_sent when the meeting is unknown", async () => {
    const runner = makeMockRunnerPointingAt(fakeBot);
    const { received, dispose } = captureHub();

    try {
      const manager = _createMeetSessionManagerForTests({
        dockerRunnerFactory: () => runner,
        getProviderKey: async () => "",
        getWorkspaceDir: () => workspaceDir,
        botLeaveFetch: async () => {},
        audioIngestFactory: makeFakeAudioIngest,
      });

      // No `join()` call — sendChat against a meetingId that was never
      // registered is the error path the `meet_send_chat` tool relies on.
      await expect(manager.sendChat("never-joined", "hi")).rejects.toThrow(
        MeetSessionNotFoundError,
      );

      // Fake bot must not have seen the request.
      expect(fakeBot.requests).toHaveLength(0);

      // Nor should the event hub have published anything chat-shaped.
      await Promise.resolve();
      await Promise.resolve();
      const chatSent = received.filter(
        (e) => e.message.type === "meet.chat_sent",
      );
      expect(chatSent).toHaveLength(0);
    } finally {
      dispose();
    }
  });

  test("propagates MeetBotChatError when the bot responds with 502 and does NOT publish meet.chat_sent", async () => {
    // Simulates the Playwright-failure path on the bot: PR 1's handler
    // returns 502 when `sendChat(page, text)` throws (selector drift,
    // panel missing, etc.). The daemon must surface this as a domain
    // error and must NOT announce a successful send to SSE subscribers.
    const runner = makeMockRunnerPointingAt(fakeBot);
    const { received, dispose } = captureHub();
    try {
      const manager = _createMeetSessionManagerForTests({
        dockerRunnerFactory: () => runner,
        getProviderKey: async () => "",
        getWorkspaceDir: () => workspaceDir,
        botLeaveFetch: async () => {},
        audioIngestFactory: makeFakeAudioIngest,
      });

      await manager.join({
        url: "u",
        meetingId: "m-chat-502",
        conversationId: "c",
      });

      fakeBot.setNextResponse(502, {
        sent: false,
        error: "selector timeout",
      });

      let caught: unknown = null;
      try {
        await manager.sendChat("m-chat-502", "will fail");
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(MeetBotChatError);
      expect((caught as MeetBotChatError).status).toBe(502);
      // The bot's error body is preserved verbatim in the thrown message
      // so the tool layer can show it to the user.
      expect((caught as MeetBotChatError).message).toContain(
        "selector timeout",
      );

      // The bot still received the request — we just responded non-OK.
      expect(fakeBot.requests).toHaveLength(1);

      // No meet.chat_sent should have been published for the failed send.
      await Promise.resolve();
      await Promise.resolve();
      const chatSent = received.filter(
        (e) => e.message.type === "meet.chat_sent",
      );
      expect(chatSent).toHaveLength(0);

      await manager.leave("m-chat-502", "cleanup");
    } finally {
      dispose();
    }
  });

  test("maps network-level failure to MeetSessionUnreachableError", async () => {
    // Tear the bot server down BEFORE issuing sendChat so the fetch
    // hits a refused connection — the default `botSendChatFetch` wraps
    // that into `MeetSessionUnreachableError`.
    const runner = makeMockRunnerPointingAt(fakeBot);
    const { received, dispose } = captureHub();
    try {
      const manager = _createMeetSessionManagerForTests({
        dockerRunnerFactory: () => runner,
        getProviderKey: async () => "",
        getWorkspaceDir: () => workspaceDir,
        botLeaveFetch: async () => {},
        audioIngestFactory: makeFakeAudioIngest,
      });

      await manager.join({
        url: "u",
        meetingId: "m-chat-down",
        conversationId: "c",
      });

      // Drop the server so the next fetch observes connection refused /
      // dns failure / reset — whichever the kernel produces.
      await fakeBot.stop();

      let caught: unknown = null;
      try {
        await manager.sendChat("m-chat-down", "unreachable");
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(MeetSessionUnreachableError);

      // Nothing published — the send never completed.
      await Promise.resolve();
      await Promise.resolve();
      const chatSent = received.filter(
        (e) => e.message.type === "meet.chat_sent",
      );
      expect(chatSent).toHaveLength(0);

      // Restart the fake bot so the `afterEach` cleanup has something to
      // `.stop()` without throwing — our server wrapper is tolerant of
      // being stopped once, but `startFakeBot` is invoked per test and
      // the afterEach hook expects a live handle.
      fakeBot = startFakeBot();

      await manager.leave("m-chat-down", "cleanup");
    } finally {
      dispose();
    }
  });
});
