import { describe, expect, mock, test } from "bun:test";

import {
  type LiveVoiceSession,
  type LiveVoiceSessionCloseReason,
  type LiveVoiceSessionFactoryContext,
  LiveVoiceSessionManager,
  LiveVoiceSessionStartupError,
  type LiveVoiceSlotEvent,
} from "../live-voice-session-manager.js";
import type {
  LiveVoiceClientFrame,
  LiveVoiceClientStartFrame,
  LiveVoiceServerFrame,
} from "../protocol.js";

const START_FRAME = {
  type: "start",
  conversationId: "conversation-123",
  audio: {
    mimeType: "audio/pcm",
    sampleRate: 24_000,
    channels: 1,
  },
} as const satisfies LiveVoiceClientStartFrame;

interface TestSession extends LiveVoiceSession {
  readonly clientFrames: LiveVoiceClientFrame[];
  readonly binaryChunks: Uint8Array[];
  readonly closeReasons: LiveVoiceSessionCloseReason[];
}

function createTestSession(overrides: Partial<LiveVoiceSession> = {}) {
  const session: TestSession = {
    clientFrames: [],
    binaryChunks: [],
    closeReasons: [],
    start: mock(() => {}),
    handleClientFrame: mock((frame: LiveVoiceClientFrame) => {
      session.clientFrames.push(frame);
    }),
    handleBinaryAudio: mock((chunk: Uint8Array) => {
      session.binaryChunks.push(chunk);
    }),
    close: mock((reason: LiveVoiceSessionCloseReason) => {
      session.closeReasons.push(reason);
    }),
    ...overrides,
  };
  return session;
}

function createSink() {
  const frames: LiveVoiceServerFrame[] = [];
  return {
    frames,
    sink: {
      sendFrame: mock((frame: LiveVoiceServerFrame) => {
        frames.push(frame);
      }),
    },
  };
}

describe("LiveVoiceSessionManager", () => {
  test("creates and starts the first accepted live voice session", async () => {
    const sessions: TestSession[] = [];
    const contexts: LiveVoiceSessionFactoryContext[] = [];
    const manager = new LiveVoiceSessionManager({
      createSessionId: () => "session-1",
      createSession: (context) => {
        contexts.push(context);
        const session = createTestSession({
          start: mock(async () => {
            await context.sendFrame({
              type: "ready",
              sessionId: context.sessionId,
              conversationId:
                context.startFrame.conversationId ?? "conversation-new",
            });
          }),
        });
        sessions.push(session);
        return session;
      },
    });
    const { frames, sink } = createSink();

    const result = await manager.startSession(START_FRAME, sink);

    expect(result).toEqual({ status: "accepted", sessionId: "session-1" });
    expect(manager.activeSessionId).toBe("session-1");
    expect(contexts).toHaveLength(1);
    expect(contexts[0]?.sessionId).toBe("session-1");
    expect(contexts[0]?.startFrame).toEqual(START_FRAME);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.start).toHaveBeenCalledTimes(1);
    expect(frames).toEqual([
      {
        type: "ready",
        seq: 1,
        sessionId: "session-1",
        conversationId: "conversation-123",
      },
    ]);
  });

  test("rejects concurrent start attempts with a busy frame", async () => {
    const sessions: TestSession[] = [];
    const manager = new LiveVoiceSessionManager({
      createSessionId: mock(() => `session-${sessions.length + 1}`),
      createSession: () => {
        const session = createTestSession();
        sessions.push(session);
        return session;
      },
    });
    const first = createSink();
    const second = createSink();

    const accepted = await manager.startSession(START_FRAME, first.sink);
    const rejected = await manager.startSession(START_FRAME, second.sink);

    expect(accepted).toEqual({ status: "accepted", sessionId: "session-1" });
    expect(rejected).toEqual({
      status: "busy",
      activeSessionId: "session-1",
      frame: {
        type: "busy",
        seq: 1,
        activeSessionId: "session-1",
      },
    });
    expect(second.frames).toEqual([
      {
        type: "busy",
        seq: 1,
        activeSessionId: "session-1",
      },
    ]);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.start).toHaveBeenCalledTimes(1);
  });

  test("releases the active session once for repeated close events", async () => {
    const session = createTestSession();
    const manager = new LiveVoiceSessionManager({
      createSessionId: () => "session-1",
      createSession: () => session,
    });

    await manager.startSession(START_FRAME, createSink().sink);
    const firstRelease = await manager.releaseSession(
      "session-1",
      "websocket_close",
    );
    const secondRelease = await manager.releaseSession(
      "session-1",
      "websocket_close",
    );

    expect(firstRelease).toEqual({
      released: true,
      sessionId: "session-1",
    });
    expect(secondRelease).toEqual({ released: false });
    expect(session.close).toHaveBeenCalledTimes(1);
    expect(session.closeReasons).toEqual(["websocket_close"]);
    expect(manager.activeSessionId).toBeNull();
  });

  test("releases the lock on a normal end frame", async () => {
    const sessions: TestSession[] = [];
    const manager = new LiveVoiceSessionManager({
      createSessionId: mock(() => `session-${sessions.length + 1}`),
      createSession: () => {
        const session = createTestSession();
        sessions.push(session);
        return session;
      },
    });

    await manager.startSession(START_FRAME, createSink().sink);
    const result = await manager.handleClientFrame("session-1", {
      type: "end",
    });
    const next = await manager.startSession(START_FRAME, createSink().sink);

    expect(result).toEqual({ status: "handled", sessionId: "session-1" });
    expect(sessions[0]?.clientFrames).toEqual([{ type: "end" }]);
    expect(sessions[0]?.close).toHaveBeenCalledTimes(1);
    expect(sessions[0]?.closeReasons).toEqual(["client_end"]);
    expect(next).toEqual({ status: "accepted", sessionId: "session-2" });
    expect(sessions).toHaveLength(2);
  });

  test("releases the lock when session start throws", async () => {
    const sessions: TestSession[] = [];
    const manager = new LiveVoiceSessionManager({
      createSessionId: mock(() => `session-${sessions.length + 1}`),
      createSession: (context) => {
        const session = createTestSession(
          context.sessionId === "session-1"
            ? {
                start: mock(() => {
                  throw new Error("session start failed");
                }),
              }
            : {},
        );
        sessions.push(session);
        return session;
      },
    });

    await expect(
      manager.startSession(START_FRAME, createSink().sink),
    ).rejects.toThrow("session start failed");
    const retry = await manager.startSession(START_FRAME, createSink().sink);

    expect(sessions[0]?.closeReasons).toEqual(["error"]);
    expect(retry).toEqual({ status: "accepted", sessionId: "session-2" });
    expect(manager.activeSessionId).toBe("session-2");
  });

  test("releases the lock without rethrowing terminal startup failures", async () => {
    const sessions: TestSession[] = [];
    const first = createSink();
    const second = createSink();
    const startupErrorMessage = "Live voice transcription could not be started";
    const manager = new LiveVoiceSessionManager({
      createSessionId: mock(() => `session-${sessions.length + 1}`),
      createSession: (context) => {
        const session = createTestSession(
          context.sessionId === "session-1"
            ? {
                start: mock(async () => {
                  await context.sendFrame({
                    type: "error",
                    code: "invalid_field",
                    message: startupErrorMessage,
                  });
                  throw new LiveVoiceSessionStartupError(startupErrorMessage);
                }),
              }
            : {},
        );
        sessions.push(session);
        return session;
      },
    });

    const failed = await manager.startSession(START_FRAME, first.sink);
    const retry = await manager.startSession(START_FRAME, second.sink);

    expect(failed).toEqual({ status: "failed", sessionId: "session-1" });
    expect(first.frames).toEqual([
      {
        type: "error",
        seq: 1,
        code: "invalid_field",
        message: startupErrorMessage,
      },
    ]);
    expect(sessions[0]?.closeReasons).toEqual(["error"]);
    expect(retry).toEqual({ status: "accepted", sessionId: "session-2" });
    expect(manager.activeSessionId).toBe("session-2");
  });

  test("releases the lock when session frame handling throws", async () => {
    const session = createTestSession({
      handleClientFrame: mock(() => {
        throw new Error("client frame failed");
      }),
    });
    const manager = new LiveVoiceSessionManager({
      createSessionId: () => "session-1",
      createSession: () => session,
    });

    await manager.startSession(START_FRAME, createSink().sink);

    await expect(
      manager.handleClientFrame("session-1", { type: "interrupt" }),
    ).rejects.toThrow("client frame failed");
    expect(session.closeReasons).toEqual(["error"]);
    expect(manager.activeSessionId).toBeNull();
  });

  test("releases the lock when binary audio handling throws", async () => {
    const session = createTestSession({
      handleBinaryAudio: mock(() => {
        throw new Error("binary audio failed");
      }),
    });
    const manager = new LiveVoiceSessionManager({
      createSessionId: () => "session-1",
      createSession: () => session,
    });

    await manager.startSession(START_FRAME, createSink().sink);

    await expect(
      manager.handleBinaryAudio("session-1", new Uint8Array([1, 2, 3])),
    ).rejects.toThrow("binary audio failed");
    expect(session.closeReasons).toEqual(["error"]);
    expect(manager.activeSessionId).toBeNull();
  });

  test("ignores stale session ids without releasing the active lock", async () => {
    const session = createTestSession();
    const manager = new LiveVoiceSessionManager({
      createSessionId: () => "session-1",
      createSession: () => session,
    });

    await manager.startSession(START_FRAME, createSink().sink);

    expect(
      await manager.handleClientFrame("session-stale", { type: "end" }),
    ).toEqual({ status: "not_found" });
    expect(
      await manager.handleBinaryAudio("session-stale", new Uint8Array([1])),
    ).toEqual({ status: "not_found" });
    expect(
      await manager.releaseSession("session-stale", "websocket_close"),
    ).toEqual({ released: false });
    expect(session.close).not.toHaveBeenCalled();
    expect(manager.activeSessionId).toBe("session-1");
  });

  test("makes a start that arrives mid-close wait for the slot", async () => {
    const sessions: TestSession[] = [];
    let resolveClose: (() => void) | undefined;
    const manager = new LiveVoiceSessionManager({
      createSessionId: mock(() => `session-${sessions.length + 1}`),
      createSession: () => {
        const session = createTestSession({
          close: mock(
            (reason: LiveVoiceSessionCloseReason) =>
              new Promise<void>((resolve) => {
                sessions[sessions.length - 1]?.closeReasons.push(reason);
                resolveClose = resolve;
              }),
          ),
        });
        sessions.push(session);
        return session;
      },
    });
    const first = createSink();
    const second = createSink();

    await manager.startSession(START_FRAME, first.sink);
    const releasePromise = manager.releaseSession("session-1", "client_end");
    // The reconnect: a fresh transport asking for a session while the previous
    // one is still unwinding. It must not be told the dying session is active.
    const concurrent = manager.startSession(START_FRAME, second.sink);
    const concurrentDispatch = await manager.handleClientFrame("session-1", {
      type: "interrupt",
    });

    expect(concurrentDispatch).toEqual({ status: "not_found" });
    // The lock still holds: no second session exists alongside the closing one.
    expect(sessions).toHaveLength(1);
    expect(second.frames).toEqual([]);

    resolveClose?.();
    await releasePromise;

    expect(await concurrent).toEqual({
      status: "accepted",
      sessionId: "session-2",
    });
    expect(manager.activeSessionId).toBe("session-2");
  });

  test("does not import runtime, gateway, provider, or conversation modules", async () => {
    const source = await Bun.file(
      new URL("../live-voice-session-manager.ts", import.meta.url),
    ).text();
    const imports = Array.from(
      source.matchAll(/from\s+["']([^"']+)["']/g),
      (match) => match[1],
    );

    expect(imports).toEqual(["node:crypto", "./protocol.js"]);
    for (const importPath of imports) {
      expect(importPath).not.toContain("runtime");
      expect(importPath).not.toContain("gateway");
      expect(importPath).not.toContain("stt");
      expect(importPath).not.toContain("tts");
      expect(importPath).not.toContain("conversation");
    }
  });
});

/**
 * Closure assurance (LUM-3440): the slot must come back on its own from every
 * way a session can stop being usable, because the client whose transport
 * died cannot ask for it back and a user who force-quits the app does not get
 * a second chance either.
 */
describe("LiveVoiceSessionManager slot reclamation", () => {
  const SERVER_VAD_START = {
    ...START_FRAME,
    turnDetection: "server_vad",
  } as const satisfies LiveVoiceClientStartFrame;

  const sleep = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  test("frees the slot when a session's close never finishes", async () => {
    const events: LiveVoiceSlotEvent[] = [];
    const sessions: TestSession[] = [];
    const manager = new LiveVoiceSessionManager({
      createSessionId: mock(() => `session-${sessions.length + 1}`),
      closeTimeoutMs: 25,
      createSession: () => {
        const session = createTestSession({
          // A teardown that hangs: the shape of a close awaiting a
          // continuation delivery or a provider that never answers.
          close: mock(() => new Promise<void>(() => {})),
        });
        sessions.push(session);
        return session;
      },
      onSlotEvent: (event) => events.push(event),
    });

    await manager.startSession(START_FRAME, createSink().sink);
    await manager.releaseSession("session-1", "websocket_close");

    expect(manager.activeSessionId).toBeNull();
    expect(events).toEqual([
      {
        kind: "close_timed_out",
        sessionId: "session-1",
        reason: "websocket_close",
        timeoutMs: 25,
      },
    ]);

    // The whole point: the next session starts instead of being told the
    // wedged one is still active.
    const next = await manager.startSession(START_FRAME, createSink().sink);
    expect(next).toEqual({ status: "accepted", sessionId: "session-2" });
  });

  test("releases a server_vad session whose client goes silent", async () => {
    const events: LiveVoiceSlotEvent[] = [];
    const session = createTestSession();
    const manager = new LiveVoiceSessionManager({
      createSessionId: () => "session-1",
      clientSilenceTimeoutMs: 30,
      createSession: () => session,
      onSlotEvent: (event) => events.push(event),
    });

    await manager.startSession(SERVER_VAD_START, createSink().sink);
    expect(manager.activeSessionId).toBe("session-1");

    await sleep(90);

    expect(manager.activeSessionId).toBeNull();
    expect(session.closeReasons).toEqual(["client_timeout"]);
    expect(events).toEqual([
      {
        kind: "client_silence_timeout",
        sessionId: "session-1",
        timeoutMs: 30,
      },
    ]);
  });

  test("hangs up the transport it reclaimed the slot from", async () => {
    const session = createTestSession();
    const manager = new LiveVoiceSessionManager({
      createSessionId: () => "session-1",
      clientSilenceTimeoutMs: 30,
      createSession: () => session,
    });
    const closeTransport = mock(() => {});
    const { sink } = createSink();

    await manager.startSession(SERVER_VAD_START, { ...sink, closeTransport });
    await sleep(90);

    // Reclaiming the slot alone would leave the client streaming into a
    // session that no longer exists, and every socket out to it open.
    expect(closeTransport).toHaveBeenCalledTimes(1);
    expect(session.closeReasons).toEqual(["client_timeout"]);
  });

  test("inbound audio pushes the silence deadline out", async () => {
    const session = createTestSession();
    const manager = new LiveVoiceSessionManager({
      createSessionId: () => "session-1",
      clientSilenceTimeoutMs: 60,
      createSession: () => session,
    });

    await manager.startSession(SERVER_VAD_START, createSink().sink);
    await sleep(40);
    await manager.handleBinaryAudio("session-1", new Uint8Array([1, 2, 3]));
    // Past the original deadline: only the refresh keeps this session alive.
    await sleep(40);

    expect(manager.activeSessionId).toBe("session-1");
    expect(session.closeReasons).toEqual([]);
  });

  test("leaves a manual session alone, its silence is not evidence", async () => {
    const session = createTestSession();
    const manager = new LiveVoiceSessionManager({
      createSessionId: () => "session-1",
      clientSilenceTimeoutMs: 20,
      createSession: () => session,
    });

    await manager.startSession(
      { ...START_FRAME, turnDetection: "manual" },
      createSink().sink,
    );
    await sleep(70);

    expect(manager.activeSessionId).toBe("session-1");
    expect(session.closeReasons).toEqual([]);
  });

  test("abandons a start whose transport went away while it waited", async () => {
    const sessions: TestSession[] = [];
    const manager = new LiveVoiceSessionManager({
      createSessionId: mock(() => `session-${sessions.length + 1}`),
      createSession: () => {
        const session = createTestSession({
          close: mock(() => new Promise<void>(() => {})),
        });
        sessions.push(session);
        return session;
      },
    });
    const second = createSink();

    await manager.startSession(START_FRAME, createSink().sink);
    void manager.releaseSession("session-1", "transport_closed");

    const abort = new AbortController();
    const pending = manager.startSession(START_FRAME, second.sink, {
      signal: abort.signal,
    });
    await sleep(0);
    // The socket that asked gave up while the outgoing slot was still
    // unwinding. Building its session anyway would hand the slot to nobody.
    abort.abort();

    expect(await pending).toEqual({ status: "aborted" });
    expect(sessions).toHaveLength(1);
    expect(second.frames).toEqual([]);
  });

  test("hangs up the transport when the slot is force-ended", async () => {
    const session = createTestSession();
    const manager = new LiveVoiceSessionManager({
      createSessionId: () => "session-1",
      createSession: () => session,
    });
    const closeTransport = mock(() => {});
    const { sink } = createSink();

    await manager.startSession(START_FRAME, { ...sink, closeTransport });
    await manager.endActiveSession();

    // Otherwise the client whose session was ended from elsewhere keeps
    // showing an active call until it happens to send another frame.
    expect(closeTransport).toHaveBeenCalledTimes(1);
    expect(session.closeReasons).toEqual(["forced_end"]);
  });

  test("ends the active session on request, whoever holds it", async () => {
    const session = createTestSession();
    const manager = new LiveVoiceSessionManager({
      createSessionId: () => "session-1",
      createSession: () => session,
    });

    expect(await manager.endActiveSession()).toEqual({ released: false });

    await manager.startSession(START_FRAME, createSink().sink);
    expect(await manager.endActiveSession()).toEqual({
      released: true,
      sessionId: "session-1",
    });
    expect(session.closeReasons).toEqual(["forced_end"]);
    expect(manager.activeSessionId).toBeNull();
  });
});
