import { describe, expect, test } from "bun:test";

import { initializeDb } from "../../../persistence/db-init.js";
import type {
  StreamingTranscriber,
  SttStreamServerEvent,
} from "../../../stt/types.js";
import type { WatchSessionSummary } from "../../../watch/watch-session-manager.js";
import { WatchSessionManager } from "../../../watch/watch-session-manager.js";
import { renderWatchTimeline } from "../../../watch/watch-timeline.js";
import type { HostObservation } from "../../host-observe.js";
import {
  drainWatchRetros,
  type WatchStreamServerFrame,
  WatchStreamSession,
  type WatchStreamSocket,
} from "../watch-routes.js";

await initializeDb();

const PRINCIPAL_ID = "principal-watch-stream-test";

/** A socket that keeps every frame the session sent it. */
class FakeSocket implements WatchStreamSocket {
  readonly frames: WatchStreamServerFrame[] = [];
  closeCode: number | null = null;
  closeReason: string | null = null;

  send(data: string): void {
    this.frames.push(JSON.parse(data) as WatchStreamServerFrame);
  }

  close(code?: number, reason?: string): void {
    this.closeCode = code ?? null;
    this.closeReason = reason ?? null;
  }

  types(): string[] {
    return this.frames.map((frame) => frame.type);
  }

  firstOfType<T extends WatchStreamServerFrame["type"]>(
    type: T,
  ): Extract<WatchStreamServerFrame, { type: T }> | undefined {
    return this.frames.find((frame) => frame.type === type) as
      | Extract<WatchStreamServerFrame, { type: T }>
      | undefined;
  }
}

/** A transcriber the test drives by hand. */
class FakeTranscriber implements StreamingTranscriber {
  readonly providerId = "deepgram" as const;
  readonly boundaryId = "daemon-streaming" as const;
  readonly audio: { bytes: Buffer; mimeType: string }[] = [];
  stopCount = 0;
  private onEvent: ((event: SttStreamServerEvent) => void) | null = null;

  async start(onEvent: (event: SttStreamServerEvent) => void): Promise<void> {
    this.onEvent = onEvent;
  }

  sendAudio(audio: Buffer, mimeType: string): void {
    this.audio.push({ bytes: audio, mimeType });
  }

  stop(): void {
    this.stopCount += 1;
  }

  emit(event: SttStreamServerEvent): void {
    this.onEvent?.(event);
  }
}

function observation(): HostObservation {
  return {
    ok: true,
    axTree: "Window: Editor\n[1] Button Save",
  };
}

/**
 * A manager wired to a scripted screen reader, so a session's cadence is a
 * function of what the test says the host answered rather than of a real
 * desktop client.
 */
function newManager() {
  const observeCalls: (string | undefined)[] = [];
  const manager = new WatchSessionManager({
    observe: async (options) => {
      observeCalls.push(options.sourceActorPrincipalId);
      return observation();
    },
  });
  return { manager, observeCalls };
}

interface HarnessOverrides {
  manager?: WatchSessionManager;
  transcriber?: FakeTranscriber | null;
  principalId?: string | undefined;
  idleTimeoutMs?: number;
  /** How long the stand-in retrospective takes before it settles. */
  retroDelayMs?: number;
}

function newSession(overrides: HarnessOverrides = {}) {
  const ws = new FakeSocket();
  const transcriber =
    overrides.transcriber === undefined
      ? new FakeTranscriber()
      : overrides.transcriber;
  const manager = overrides.manager ?? newManager().manager;
  // The retrospective is a full agent turn, so every session in this file gets
  // a stand-in for it and the tests read what it was handed. `finished` flips
  // once the stand-in returns, which is what a drain has to wait for.
  const retros: WatchSessionSummary[] = [];
  const finished: WatchSessionSummary[] = [];
  const session = new WatchStreamSession(ws, {
    mimeType: "audio/webm",
    manager,
    resolveTranscriber: async () => transcriber,
    resolveActorPrincipalId: async () =>
      "principalId" in overrides ? overrides.principalId : PRINCIPAL_ID,
    runRetro: async (summary) => {
      retros.push(summary);
      if (overrides.retroDelayMs !== undefined) {
        await Bun.sleep(overrides.retroDelayMs);
      }
      finished.push(summary);
    },
    ...(overrides.idleTimeoutMs !== undefined
      ? { idleTimeoutMs: overrides.idleTimeoutMs }
      : {}),
  });
  return { ws, transcriber, manager, session, retros, finished };
}

describe("watch stream session", () => {
  test("starts, records narration, and stops", async () => {
    const { manager, observeCalls } = newManager();
    const { ws, transcriber, session } = newSession({ manager });
    await session.start();

    const ready = ws.firstOfType("ready");
    expect(ready).toBeDefined();
    expect(manager.isActive(ready!.conversationId)).toBe(true);

    transcriber!.emit({ type: "final", text: "  opening the invoice  " });
    // The narration lands synchronously; the screen read it triggers does not.
    await Bun.sleep(5);

    expect(ws.types()).toEqual(["ready", "entry"]);
    expect(observeCalls).toEqual([PRINCIPAL_ID]);

    const rendered = renderWatchTimeline(ready!.sessionId);
    expect(rendered.totalEntries).toBe(2);
    expect(rendered.text).toContain("opening the invoice");

    session.handleMessage(JSON.stringify({ type: "stop" }));
    expect(transcriber!.stopCount).toBe(1);
    // The provider flushes and then reports its own close.
    transcriber!.emit({ type: "closed" });

    expect(ws.types()).toEqual(["ready", "entry", "closed"]);
    expect(manager.isActive()).toBe(false);
    expect(session.isClosed).toBe(true);
  });

  test("forwards binary and base64 audio frames to the transcriber", async () => {
    const { ws, transcriber, session } = newSession();
    await session.start();

    session.handleBinaryAudio(Buffer.from([1, 2, 3]));
    session.handleMessage(
      JSON.stringify({
        type: "audio",
        audio: Buffer.from([4, 5]).toString("base64"),
        mimeType: "audio/pcm",
      }),
    );

    expect(transcriber!.audio).toHaveLength(2);
    expect([...transcriber!.audio[0]!.bytes]).toEqual([1, 2, 3]);
    expect(transcriber!.audio[0]!.mimeType).toBe("audio/webm");
    expect([...transcriber!.audio[1]!.bytes]).toEqual([4, 5]);
    expect(transcriber!.audio[1]!.mimeType).toBe("audio/pcm");
    expect(ws.types()).toEqual(["ready"]);

    session.destroy();
  });

  test("draws no transcript: partials produce no frames", async () => {
    const { ws, transcriber, session } = newSession();
    await session.start();

    transcriber!.emit({ type: "partial", text: "half a sen" });
    transcriber!.emit({ type: "turn-end", text: "half a sentence" });
    transcriber!.emit({ type: "final", text: "   " });

    expect(ws.types()).toEqual(["ready"]);

    session.destroy();
  });

  test("an unresolvable actor principal fails without opening a session", async () => {
    const { manager } = newManager();
    const { ws, transcriber, session } = newSession({
      manager,
      principalId: undefined,
    });
    await session.start();

    expect(ws.types()).toEqual(["error", "closed"]);
    expect(ws.firstOfType("error")!.category).toBe("session-error");
    expect(ws.closeCode).toBe(1008);
    expect(manager.isActive()).toBe(false);
    // The provider stream is never opened for a session that could observe
    // nothing, so there is nothing to stop.
    expect(transcriber!.stopCount).toBe(0);
    expect(session.isClosed).toBe(true);
  });

  test("provider resolution failure yields a clean error then closed", async () => {
    const { manager } = newManager();
    const { ws, session } = newSession({ manager, transcriber: null });
    await session.start();

    expect(ws.types()).toEqual(["error", "closed"]);
    expect(ws.firstOfType("error")!.category).toBe("provider-error");
    expect(manager.isActive()).toBe(false);
    expect(session.isClosed).toBe(true);
  });

  test("a second socket is turned away without disturbing the running session", async () => {
    const { manager } = newManager();
    const first = newSession({ manager });
    await first.session.start();
    const runningConversationId = first.ws.firstOfType("ready")!.conversationId;

    const second = newSession({ manager });
    await second.session.start();

    expect(second.ws.types()).toEqual(["error", "closed"]);
    expect(second.ws.firstOfType("error")!.message).toContain(
      "already running",
    );
    // The loser's teardown must not release the winner's slot.
    expect(manager.isActive(runningConversationId)).toBe(true);
    expect(second.transcriber!.stopCount).toBe(1);

    first.session.destroy();
    expect(manager.isActive()).toBe(false);
  });

  test("an abandoned socket is torn down by the idle timeout", async () => {
    const { manager } = newManager();
    const { ws, transcriber, session } = newSession({
      manager,
      idleTimeoutMs: 20,
    });
    await session.start();
    expect(manager.isActive()).toBe(true);

    await Bun.sleep(60);

    expect(ws.types()).toEqual(["ready", "error", "closed"]);
    expect(ws.firstOfType("error")!.category).toBe("timeout");
    expect(ws.closeCode).toBe(1000);
    expect(transcriber!.stopCount).toBe(1);
    expect(manager.isActive()).toBe(false);
    expect(session.isClosed).toBe(true);
  });

  test("inbound audio keeps the idle timeout at bay", async () => {
    const { manager } = newManager();
    const { ws, session } = newSession({ manager, idleTimeoutMs: 40 });
    await session.start();

    for (let i = 0; i < 4; i += 1) {
      await Bun.sleep(15);
      session.handleBinaryAudio(Buffer.from([i]));
    }

    expect(ws.types()).toEqual(["ready"]);
    expect(manager.isActive()).toBe(true);

    session.destroy();
  });

  test("teardown runs the retrospective once, on the session it just ended", async () => {
    const { manager } = newManager();
    const { ws, transcriber, session, retros } = newSession({ manager });
    await session.start();
    const ready = ws.firstOfType("ready")!;

    transcriber!.emit({ type: "final", text: "renaming the export" });
    await Bun.sleep(5);

    expect(retros).toHaveLength(0);

    session.handleMessage(JSON.stringify({ type: "stop" }));
    transcriber!.emit({ type: "closed" });

    expect(retros).toHaveLength(1);
    expect(retros[0]!.sessionId).toBe(ready.sessionId);
    expect(retros[0]!.conversationId).toBe(ready.conversationId);
    expect(retros[0]!.entryCount).toBe(2);

    // The close that follows the provider's own is a no-op, so a socket that
    // reports both does not report the session twice.
    session.handleClose(1000, "session complete");
    expect(retros).toHaveLength(1);
  });

  test("a socket turned away as busy runs no retrospective", async () => {
    const { manager } = newManager();
    const first = newSession({ manager });
    await first.session.start();

    const second = newSession({ manager });
    await second.session.start();

    expect(second.retros).toHaveLength(0);

    first.session.handleClose(1000, "done");
    expect(first.retros).toHaveLength(1);
  });

  test("shutdown tears the session down without starting a retrospective", async () => {
    const { manager } = newManager();
    const { transcriber, session, retros } = newSession({ manager });
    await session.start();
    transcriber!.emit({ type: "final", text: "renaming the export" });
    await Bun.sleep(5);

    session.destroy();

    // The process is going away, so a turn started here would be killed
    // partway through. The timeline it would have read outlives the daemon.
    expect(retros).toHaveLength(0);
    expect(manager.isActive()).toBe(false);
    expect(session.isClosed).toBe(true);
  });

  test("shutdown waits for a retrospective that was already running", async () => {
    const { manager } = newManager();
    const { session, retros, finished } = newSession({
      manager,
      retroDelayMs: 30,
    });
    await session.start();

    session.handleClose(1000, "done");
    expect(retros).toHaveLength(1);
    // Teardown does not block on the turn, so it is still going here.
    expect(finished).toHaveLength(0);

    expect(await drainWatchRetros(2_000)).toBe(0);

    expect(finished).toHaveLength(1);
  });

  test("a settled retrospective is forgotten, so the registry stays bounded", async () => {
    const { manager } = newManager();
    const first = newSession({ manager });
    await first.session.start();
    first.session.handleClose(1000, "done");
    expect(await drainWatchRetros(2_000)).toBe(0);

    const second = newSession({ manager });
    await second.session.start();
    second.session.handleClose(1000, "done");

    // Only the second session's retro is outstanding. The first was dropped
    // when it settled rather than accumulating for the life of the process.
    expect(await drainWatchRetros(2_000)).toBe(0);
    expect(first.finished).toHaveLength(1);
    expect(second.finished).toHaveLength(1);
  });

  test("the drain gives up rather than holding shutdown open", async () => {
    const { manager } = newManager();
    const { session, finished } = newSession({ manager, retroDelayMs: 400 });
    await session.start();

    session.handleClose(1000, "done");
    const startedAtMs = Date.now();
    const unsettled = await drainWatchRetros(20);

    // It returns on its own deadline, and the unfinished turn is cut off
    // rather than allowed to fail the shutdown that is cutting it off.
    expect(unsettled).toBe(1);
    expect(Date.now() - startedAtMs).toBeLessThan(300);
    expect(finished).toHaveLength(0);
    // Let the straggler settle so it does not leak into the next test.
    await Bun.sleep(450);
  });

  test("a dropped socket releases the session slot", async () => {
    const { manager } = newManager();
    const { transcriber, session } = newSession({ manager });
    await session.start();

    session.handleClose(1006, "abnormal closure");

    expect(manager.isActive()).toBe(false);
    expect(transcriber!.stopCount).toBe(1);

    // A second close is a no-op rather than a second stop.
    session.handleClose(1006, "abnormal closure");
    expect(transcriber!.stopCount).toBe(1);
  });
});
