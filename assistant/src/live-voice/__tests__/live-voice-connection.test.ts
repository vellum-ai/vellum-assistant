import { afterEach, describe, expect, mock, test } from "bun:test";

import {
  createLiveVoiceConnection,
  type LiveVoiceConnection,
} from "../live-voice-connection.js";
import { setLiveVoiceSessionManagerForTesting } from "../live-voice-manager.js";
import {
  type LiveVoiceSession,
  type LiveVoiceSessionCloseReason,
  LiveVoiceSessionManager,
} from "../live-voice-session-manager.js";
import type {
  LiveVoiceClientFrame,
  LiveVoiceServerFrame,
} from "../protocol.js";

const START_MESSAGE = JSON.stringify({
  type: "start",
  conversationId: "conversation-123",
  audio: { mimeType: "audio/pcm", sampleRate: 24_000, channels: 1 },
});

interface TestSession extends LiveVoiceSession {
  readonly clientFrames: LiveVoiceClientFrame[];
  readonly binaryChunks: Uint8Array[];
  readonly closeReasons: LiveVoiceSessionCloseReason[];
}

/**
 * Wire a real {@link LiveVoiceSessionManager} to fake sessions and install it
 * as the process singleton so {@link createLiveVoiceConnection} drives it.
 * Returns the manager and the list of sessions it has created (each `start`
 * emits a `ready` frame through the session's sink, like the real one).
 */
function installFakeManager(
  overrides: (
    session: TestSession,
    ctx: { sessionId: string },
  ) => Partial<LiveVoiceSession> = () => ({}),
): { manager: LiveVoiceSessionManager; sessions: TestSession[] } {
  const sessions: TestSession[] = [];
  let counter = 0;
  const manager = new LiveVoiceSessionManager({
    createSessionId: () => `session-${(counter += 1)}`,
    createSession: (context) => {
      const session: TestSession = {
        clientFrames: [],
        binaryChunks: [],
        closeReasons: [],
        start: mock(async () => {
          await context.sendFrame({
            type: "ready",
            sessionId: context.sessionId,
            conversationId:
              context.startFrame.conversationId ?? "conversation-new",
          });
        }),
        handleClientFrame: mock((frame: LiveVoiceClientFrame) => {
          session.clientFrames.push(frame);
        }),
        handleBinaryAudio: mock((chunk: Uint8Array) => {
          session.binaryChunks.push(chunk);
        }),
        close: mock((reason: LiveVoiceSessionCloseReason) => {
          session.closeReasons.push(reason);
        }),
      };
      Object.assign(
        session,
        overrides(session, { sessionId: context.sessionId }),
      );
      sessions.push(session);
      return session;
    },
  });
  setLiveVoiceSessionManagerForTesting(manager);
  return { manager, sessions };
}

function createConnection(): {
  connection: LiveVoiceConnection;
  frames: LiveVoiceServerFrame[];
} {
  const frames: LiveVoiceServerFrame[] = [];
  const connection = createLiveVoiceConnection({
    send: (frame) => {
      frames.push(frame);
    },
  });
  return { connection, frames };
}

afterEach(() => {
  setLiveVoiceSessionManagerForTesting(null);
});

describe("createLiveVoiceConnection", () => {
  test("accepts a start frame and emits the session's ready frame", async () => {
    const { sessions } = installFakeManager();
    const { connection, frames } = createConnection();

    await connection.handleMessage(START_MESSAGE);

    expect(connection.sessionId).toBe("session-1");
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

  test("assigns monotonically increasing sequence numbers", async () => {
    installFakeManager();
    const { connection, frames } = createConnection();

    await connection.handleMessage(START_MESSAGE); // ready → seq 1
    await connection.handleMessage("not json"); // error → seq 2

    expect(frames.map((f) => f.seq)).toEqual([1, 2]);
    expect(frames[1]).toMatchObject({ type: "error", seq: 2 });
  });

  test("forwards client frames to the active session", async () => {
    const { sessions } = installFakeManager();
    const { connection } = createConnection();

    await connection.handleMessage(START_MESSAGE);
    await connection.handleMessage(JSON.stringify({ type: "interrupt" }));

    expect(sessions[0]?.clientFrames).toEqual([{ type: "interrupt" }]);
  });

  test("forwards binary audio to the active session", async () => {
    const { sessions } = installFakeManager();
    const { connection } = createConnection();

    await connection.handleMessage(START_MESSAGE);
    const audio = new Uint8Array([1, 2, 3, 4]);
    await connection.handleMessage(audio.buffer);

    expect(sessions[0]?.binaryChunks).toHaveLength(1);
    expect(Array.from(sessions[0]!.binaryChunks[0]!)).toEqual([1, 2, 3, 4]);
  });

  test("rejects a second start while a session is active", async () => {
    installFakeManager();
    const { connection, frames } = createConnection();

    await connection.handleMessage(START_MESSAGE);
    await connection.handleMessage(START_MESSAGE);

    expect(connection.sessionId).toBe("session-1");
    expect(frames.at(-1)).toMatchObject({
      type: "error",
      code: "invalid_frame",
      message: "Live voice session already started",
    });
  });

  test("errors on a non-start frame before start", async () => {
    installFakeManager();
    const { connection, frames } = createConnection();

    await connection.handleMessage(JSON.stringify({ type: "ptt_release" }));

    expect(connection.sessionId).toBeUndefined();
    expect(frames.at(-1)).toMatchObject({
      type: "error",
      code: "invalid_frame",
      message: "Live voice ptt_release frame received before start",
    });
  });

  test("errors on binary audio before start", async () => {
    installFakeManager();
    const { connection, frames } = createConnection();

    await connection.handleMessage(new Uint8Array([1, 2]).buffer);

    expect(frames.at(-1)).toMatchObject({
      type: "error",
      message: "Live voice binary audio received before start",
    });
  });

  test("clears the session id on an end frame", async () => {
    const { sessions } = installFakeManager();
    const { connection } = createConnection();

    await connection.handleMessage(START_MESSAGE);
    await connection.handleMessage(JSON.stringify({ type: "end" }));

    expect(connection.sessionId).toBeUndefined();
    expect(sessions[0]?.clientFrames).toEqual([{ type: "end" }]);
  });

  test("heals a stale binding when the manager dropped the session", async () => {
    const { manager } = installFakeManager();
    const { connection, frames } = createConnection();

    await connection.handleMessage(START_MESSAGE);
    // The session's slot is released out-of-band (e.g. a post-ready failure)
    // without a frame crossing this connection.
    await manager.releaseSession("session-1", "error");

    await connection.handleMessage(JSON.stringify({ type: "interrupt" }));

    expect(connection.sessionId).toBeUndefined();
    expect(frames.at(-1)).toMatchObject({
      type: "error",
      message: "Live voice session is not active",
    });
  });

  test("starts a fresh session after the previous slot was released", async () => {
    const { manager } = installFakeManager();
    const { connection } = createConnection();

    await connection.handleMessage(START_MESSAGE);
    await manager.releaseSession("session-1", "error");
    await connection.handleMessage(START_MESSAGE);

    expect(connection.sessionId).toBe("session-2");
  });

  test("reports handler failures as an error frame instead of rejecting", async () => {
    installFakeManager((_session) => ({
      handleClientFrame: mock(() => {
        throw new Error("boom");
      }),
    }));
    const { connection, frames } = createConnection();

    await connection.handleMessage(START_MESSAGE);
    await expect(
      connection.handleMessage(JSON.stringify({ type: "interrupt" })),
    ).resolves.toBeUndefined();

    expect(frames.at(-1)).toMatchObject({
      type: "error",
      code: "invalid_frame",
      message: "Live voice frame handling failed",
    });
  });

  test("release closes the active session with transport_closed", async () => {
    const { sessions } = installFakeManager();
    const { connection } = createConnection();

    await connection.handleMessage(START_MESSAGE);
    connection.release();
    // releaseSession runs asynchronously inside release().
    await Promise.resolve();

    expect(connection.sessionId).toBeUndefined();
    expect(sessions[0]?.closeReasons).toEqual(["transport_closed"]);
  });

  test("release is a no-op when no session is active", () => {
    installFakeManager();
    const { connection } = createConnection();

    expect(() => connection.release()).not.toThrow();
  });
});
