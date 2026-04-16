/**
 * Tests for the meet-bot HTTP control surface.
 *
 * The server is started on an ephemeral localhost port (via `start(0)`) for
 * every test so test cases are fully isolated and safe to run in parallel.
 * All routes require Bearer auth; unauthorized requests must be rejected
 * before any body validation runs.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  createHttpServer,
  type HttpServerHandle,
} from "../src/control/http-server.js";
import { BotState } from "../src/control/state.js";

const API_TOKEN = "test-token-abc";

interface CallbackLog {
  leaveCalls: Array<string | undefined>;
  sendChatCalls: string[];
  playAudioCalls: string[];
}

function makeServer(overrides: Partial<CallbackLog> = {}): {
  server: HttpServerHandle;
  log: CallbackLog;
} {
  const log: CallbackLog = {
    leaveCalls: [],
    sendChatCalls: [],
    playAudioCalls: [],
    ...overrides,
  };
  const server = createHttpServer({
    apiToken: API_TOKEN,
    onLeave: (reason) => {
      log.leaveCalls.push(reason);
    },
    onSendChat: (text) => {
      log.sendChatCalls.push(text);
    },
    onPlayAudio: (streamId) => {
      log.playAudioCalls.push(streamId);
    },
  });
  return { server, log };
}

async function startOnRandomPort(server: HttpServerHandle): Promise<string> {
  const { port } = await server.start(0);
  return `http://127.0.0.1:${port}`;
}

describe("http-server", () => {
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
  // auth middleware
  // -------------------------------------------------------------------------

  describe("auth", () => {
    test("rejects requests with no authorization header", async () => {
      const instance = makeServer();
      server = instance.server;
      const base = await startOnRandomPort(server);

      const res = await fetch(`${base}/status`);
      expect(res.status).toBe(401);
    });

    test("rejects a malformed authorization header", async () => {
      const instance = makeServer();
      server = instance.server;
      const base = await startOnRandomPort(server);

      const res = await fetch(`${base}/status`, {
        headers: { authorization: "Basic abc" },
      });
      expect(res.status).toBe(401);
    });

    test("rejects a wrong bearer token", async () => {
      const instance = makeServer();
      server = instance.server;
      const base = await startOnRandomPort(server);

      const res = await fetch(`${base}/status`, {
        headers: { authorization: "Bearer wrong-token" },
      });
      expect(res.status).toBe(401);
    });
  });

  // -------------------------------------------------------------------------
  // GET /health
  // -------------------------------------------------------------------------

  describe("GET /health", () => {
    test("returns 200 when phase is booting", async () => {
      const instance = makeServer();
      server = instance.server;
      const base = await startOnRandomPort(server);

      const res = await fetch(`${base}/health`, {
        headers: { authorization: `Bearer ${API_TOKEN}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; phase: string };
      expect(body.ok).toBe(true);
      expect(body.phase).toBe("booting");
    });

    test("returns 200 when phase is joined", async () => {
      const instance = makeServer();
      server = instance.server;
      const base = await startOnRandomPort(server);
      BotState.setPhase("joined");

      const res = await fetch(`${base}/health`, {
        headers: { authorization: `Bearer ${API_TOKEN}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; phase: string };
      expect(body.ok).toBe(true);
      expect(body.phase).toBe("joined");
    });

    test("returns 503 when phase is error", async () => {
      const instance = makeServer();
      server = instance.server;
      const base = await startOnRandomPort(server);
      BotState.setPhase("error");

      const res = await fetch(`${base}/health`, {
        headers: { authorization: `Bearer ${API_TOKEN}` },
      });
      expect(res.status).toBe(503);
      const body = (await res.json()) as { ok: boolean; phase: string };
      expect(body.ok).toBe(false);
      expect(body.phase).toBe("error");
    });
  });

  // -------------------------------------------------------------------------
  // GET /status
  // -------------------------------------------------------------------------

  describe("GET /status", () => {
    test("returns the current snapshot", async () => {
      const instance = makeServer();
      server = instance.server;
      const base = await startOnRandomPort(server);
      BotState.setMeeting("meet-xyz");
      BotState.setPhase("joined");

      const res = await fetch(`${base}/status`, {
        headers: { authorization: `Bearer ${API_TOKEN}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        meetingId: string | null;
        joinedAt: number | null;
        phase: string;
      };
      expect(body.meetingId).toBe("meet-xyz");
      expect(body.phase).toBe("joined");
      expect(typeof body.joinedAt).toBe("number");
    });
  });

  // -------------------------------------------------------------------------
  // POST /leave
  // -------------------------------------------------------------------------

  describe("POST /leave", () => {
    test("accepts a valid leave command and invokes onLeave", async () => {
      const instance = makeServer();
      server = instance.server;
      const base = await startOnRandomPort(server);

      const res = await fetch(`${base}/leave`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${API_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ type: "leave", reason: "test done" }),
      });
      expect(res.status).toBe(202);
      // Give the fire-and-forget callback a tick to run.
      await new Promise((r) => setTimeout(r, 10));
      expect(instance.log.leaveCalls).toEqual(["test done"]);
      expect(BotState.snapshot().phase).toBe("leaving");
    });

    test("accepts a leave with no reason", async () => {
      const instance = makeServer();
      server = instance.server;
      const base = await startOnRandomPort(server);

      const res = await fetch(`${base}/leave`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${API_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ type: "leave" }),
      });
      expect(res.status).toBe(202);
      await new Promise((r) => setTimeout(r, 10));
      expect(instance.log.leaveCalls).toEqual([undefined]);
    });

    test("rejects unauthorized requests before validation", async () => {
      const instance = makeServer();
      server = instance.server;
      const base = await startOnRandomPort(server);

      const res = await fetch(`${base}/leave`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "leave" }),
      });
      expect(res.status).toBe(401);
      expect(instance.log.leaveCalls).toEqual([]);
      expect(BotState.snapshot().phase).toBe("booting");
    });

    test("rejects an invalid body with 400", async () => {
      const instance = makeServer();
      server = instance.server;
      const base = await startOnRandomPort(server);

      const res = await fetch(`${base}/leave`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${API_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ type: "status" }),
      });
      expect(res.status).toBe(400);
      expect(instance.log.leaveCalls).toEqual([]);
    });

    test("rejects a non-JSON body with 400", async () => {
      const instance = makeServer();
      server = instance.server;
      const base = await startOnRandomPort(server);

      const res = await fetch(`${base}/leave`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${API_TOKEN}`,
          "content-type": "application/json",
        },
        body: "not json",
      });
      expect(res.status).toBe(400);
    });
  });

  // -------------------------------------------------------------------------
  // POST /send_chat
  //
  // Happy-path and failure-path coverage lives in send-chat-endpoint.test.ts.
  // These cases just sanity-check the auth/validation gate from this suite's
  // perspective so a regression in the middleware would be caught here too.
  // -------------------------------------------------------------------------

  describe("POST /send_chat", () => {
    test("invokes onSendChat and returns 200 for a valid body", async () => {
      const instance = makeServer();
      server = instance.server;
      const base = await startOnRandomPort(server);

      const res = await fetch(`${base}/send_chat`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${API_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ type: "send_chat", text: "hello" }),
      });
      expect(res.status).toBe(200);
      expect(instance.log.sendChatCalls).toEqual(["hello"]);
    });

    test("rejects an empty text body with 400", async () => {
      const instance = makeServer();
      server = instance.server;
      const base = await startOnRandomPort(server);

      const res = await fetch(`${base}/send_chat`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${API_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ type: "send_chat", text: "" }),
      });
      expect(res.status).toBe(400);
      expect(instance.log.sendChatCalls).toEqual([]);
    });

    test("requires auth", async () => {
      const instance = makeServer();
      server = instance.server;
      const base = await startOnRandomPort(server);

      const res = await fetch(`${base}/send_chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "send_chat", text: "hi" }),
      });
      expect(res.status).toBe(401);
      expect(instance.log.sendChatCalls).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // POST /play_audio
  //
  // Happy-path / ordering / cancellation coverage lives in
  // audio-playback.test.ts. These cases just sanity-check auth and
  // content-type validation at the HTTP boundary.
  // -------------------------------------------------------------------------

  describe("POST /play_audio", () => {
    test("requires auth", async () => {
      const instance = makeServer();
      server = instance.server;
      const base = await startOnRandomPort(server);

      const res = await fetch(`${base}/play_audio`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: new Uint8Array([0, 0, 0, 0]),
      });
      expect(res.status).toBe(401);
    });

    test("rejects non-octet-stream content-type with 400", async () => {
      const instance = makeServer();
      server = instance.server;
      const base = await startOnRandomPort(server);

      const res = await fetch(`${base}/play_audio`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${API_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ type: "play_audio", streamId: "s-1" }),
      });
      expect(res.status).toBe(400);
    });
  });

  // -------------------------------------------------------------------------
  // lifecycle hardening
  // -------------------------------------------------------------------------

  describe("server lifecycle", () => {
    test("start() cannot be called twice on the same instance", async () => {
      const instance = makeServer();
      server = instance.server;
      await server.start(0);
      await expect(server.start(0)).rejects.toThrow("already started");
    });

    test("stop() is idempotent", async () => {
      const instance = makeServer();
      server = instance.server;
      await server.start(0);
      await server.stop();
      await server.stop();
    });
  });
});
