/**
 * Regression test for the `/play_audio` → avatar `notifyPlaybackTimestamp`
 * bridge teardown path.
 *
 * Scenario the test guards:
 *
 *   1. `/avatar/enable` attaches a viseme-driven renderer whose
 *      `notifyPlaybackTimestamp` method is callable.
 *   2. A `/play_audio` POST is in flight — the bot has captured the
 *      renderer reference via `const renderer = avatarRenderer` at stream
 *      start and subscribed a `notify(ts)` closure to
 *      `handle.onPlaybackTimestamp`.
 *   3. `/avatar/disable` fires mid-stream. The route sets
 *      `avatarRenderer = null` and calls `renderer.stop()` — but the
 *      playback closure still holds the captured reference.
 *   4. More PCM bytes land on the POST body, producing more
 *      playback-timestamp ticks.
 *
 * Under the old (broken) code those post-disable ticks would continue
 * calling `notify(ts)` on the stopped renderer until the stream ended
 * (the unsubscribe only fires in `finally`). The fix is to guard the
 * `notify(ts)` call on the CURRENT `avatarRenderer` reference so
 * `/avatar/disable` severs the bridge immediately.
 *
 * The assertion is: every `notifyPlaybackTimestamp` call that lands on
 * the renderer must happen strictly BEFORE `/avatar/disable` completes.
 * Any tick that arrives after disable is the regression this test is
 * guarding against.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  createHttpServer,
  type HttpServerHandle,
} from "../src/control/http-server.js";
import { BotState } from "../src/control/state.js";
import {
  __resetForTests as resetPlaybackForTests,
  stopAudioPlayback,
  type PacatWritable,
  type SpawnedPacat,
} from "../src/media/audio-playback.js";
import type {
  AvatarCapabilities,
  AvatarRenderer,
  VisemeEvent,
  Y4MFrame,
} from "../src/media/avatar/index.js";
import type { VideoDeviceHandle } from "../src/media/video-device.js";

const API_TOKEN = "test-token-teardown";

/** ------------------------ shim helpers ---------------------------- */

interface PacatShim {
  proc: SpawnedPacat;
  readonly buffer: Uint8Array;
  isKilled: () => boolean;
}

/**
 * Minimal fake pacat that appends every stdin write into a single
 * buffer. Mirrors `audio-playback.test.ts`'s shim but trimmed to the
 * fields this suite needs.
 */
function makePacatShim(): PacatShim {
  let buf = new Uint8Array(0);
  let killed = false;
  let resolveExited!: (code: number) => void;
  const exited = new Promise<number>((resolve) => {
    resolveExited = resolve;
  });

  const stdin: PacatWritable = {
    write(chunk: Uint8Array): number {
      const next = new Uint8Array(buf.length + chunk.length);
      next.set(buf, 0);
      next.set(chunk, buf.length);
      buf = next;
      return chunk.length;
    },
    async end() {
      /* test controls lifetime via kill() */
    },
  };

  const proc: SpawnedPacat = {
    stdin,
    exited,
    kill() {
      if (killed) return;
      killed = true;
      resolveExited(0);
    },
  };

  return {
    proc,
    get buffer() {
      return buf;
    },
    isKilled: () => killed,
  };
}

/** ------------------------ avatar fakes ---------------------------- */

/**
 * In-memory renderer that exposes `notifyPlaybackTimestamp` so the test
 * can assert which ticks landed before vs. after `/avatar/disable`.
 *
 * Every call into `notifyPlaybackTimestamp` is logged into `ticks` along
 * with a sequence number so the post-disable regression is unambiguous.
 * The renderer's `stop()` flips `stopped` to true; the assertion later
 * checks that no tick landed after `stop()` ran (which is when the bot
 * also nulls `avatarRenderer`).
 */
class NotifyingRenderer implements AvatarRenderer {
  readonly id = "notifying";
  readonly capabilities: AvatarCapabilities = {
    needsVisemes: true,
    needsAudio: false,
  };

  startCount = 0;
  stopCount = 0;
  stopped = false;
  /** Timestamps observed through `notifyPlaybackTimestamp`. */
  readonly ticks: number[] = [];
  /** `ticks.length` at the moment `stop()` was called. */
  tickCountAtStop = -1;

  async start(): Promise<void> {
    this.startCount += 1;
  }

  async stop(): Promise<void> {
    this.stopCount += 1;
    this.tickCountAtStop = this.ticks.length;
    this.stopped = true;
  }

  pushAudio(_pcm: Uint8Array, _ts: number): void {
    /* needsAudio=false */
  }

  pushViseme(_event: VisemeEvent): void {
    /* not exercised here */
  }

  onFrame(_cb: (frame: Y4MFrame) => void): () => void {
    return () => {};
  }

  notifyPlaybackTimestamp(ts: number): void {
    this.ticks.push(ts);
  }
}

function fakeDeviceHandle(): VideoDeviceHandle {
  return {
    devicePath: "/dev/video10",
    width: 1280,
    height: 720,
    pixelFormat: "YU12",
    sink: {
      write(_chunk: Uint8Array): boolean {
        return true;
      },
      end(cb?: () => void): void {
        cb?.();
      },
      destroy(): void {
        /* noop */
      },
    },
    async close(): Promise<void> {
      /* noop */
    },
  };
}

/** ------------------------ test ------------------------------------ */

describe("/play_audio playback→renderer bridge", () => {
  let server: HttpServerHandle | null = null;

  beforeEach(() => {
    BotState.__resetForTests();
    resetPlaybackForTests();
  });

  afterEach(async () => {
    if (server !== null) {
      await server.stop();
      server = null;
    }
    await stopAudioPlayback();
    resetPlaybackForTests();
  });

  test("a mid-stream /avatar/disable severs the bridge immediately — no notifyPlaybackTimestamp ticks land on the stopped renderer", async () => {
    const shim = makePacatShim();
    const renderer = new NotifyingRenderer();

    server = createHttpServer({
      apiToken: API_TOKEN,
      onLeave: () => {},
      onSendChat: () => {},
      onPlayAudio: () => {},
      playbackSpawnOptions: { spawn: () => shim.proc },
      avatar: {
        config: { enabled: true, renderer: "notifying" },
        resolveRenderer: () => renderer,
        openDevice: async () => fakeDeviceHandle(),
      },
    });
    const { port } = await server.start(0);
    const base = `http://127.0.0.1:${port}`;

    // Wire up the avatar so the renderer is the CURRENT `avatarRenderer`
    // reference by the time /play_audio starts.
    const enable = await fetch(`${base}/avatar/enable`, {
      method: "POST",
      headers: { authorization: `Bearer ${API_TOKEN}` },
    });
    expect(enable.status).toBe(200);
    expect(renderer.startCount).toBe(1);

    // Build a gated POST body: first chunk delivers immediately, second
    // chunk is withheld until AFTER `/avatar/disable` has completed.
    // The server's write-loop pumps each delivered chunk into pacat's
    // stdin, and every non-empty write triggers a playback-timestamp
    // tick — so chunks released post-disable would ping the stopped
    // renderer under the old, unfixed code.
    const preDisableChunk = new Uint8Array(512).fill(0x11);
    const postDisableChunk = new Uint8Array(512).fill(0x22);

    let releasePostDisable!: () => void;
    const postDisableGate = new Promise<void>((resolve) => {
      releasePostDisable = resolve;
    });

    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(preDisableChunk);
        await postDisableGate;
        try {
          controller.enqueue(postDisableChunk);
        } catch {
          // Reader may have been cancelled — fine either way; this test
          // only cares that no post-disable tick lands on the renderer.
        }
        controller.close();
      },
    });

    const postPromise = fetch(`${base}/play_audio?stream_id=t1`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${API_TOKEN}`,
        "content-type": "application/octet-stream",
      },
      body,
      // @ts-expect-error — undici/fetch extension, not in lib.dom types
      duplex: "half",
    });

    // Give the server time to consume the first chunk, subscribe to
    // `onPlaybackTimestamp`, and emit at least one tick on the renderer.
    await new Promise((r) => setTimeout(r, 50));
    expect(renderer.ticks.length).toBeGreaterThanOrEqual(1);
    const ticksBeforeDisable = renderer.ticks.length;

    // Fire /avatar/disable WHILE the stream is still open. This nulls
    // out `avatarRenderer` and calls `renderer.stop()` — but the playback
    // subscription closure captured the old reference at stream start.
    const disable = await fetch(`${base}/avatar/disable`, {
      method: "POST",
      headers: { authorization: `Bearer ${API_TOKEN}` },
    });
    expect(disable.status).toBe(200);
    expect(renderer.stopped).toBe(true);
    expect(renderer.stopCount).toBe(1);
    expect(renderer.tickCountAtStop).toBeGreaterThanOrEqual(0);

    // Snapshot before we push bytes through the now-stale closure.
    const ticksRightAfterDisable = renderer.ticks.length;

    // Release the post-disable chunk. Every byte written will trigger a
    // playback-timestamp tick. Under the broken code, each of these
    // would land on the stopped renderer via the captured closure.
    // Under the fix, the CURRENT `avatarRenderer` reference is null, so
    // the guard in the closure drops every tick.
    releasePostDisable();

    const res = await postPromise;
    // Stream completed (200) — the abort would produce 499; we want the
    // natural end-of-body path so write-loop-driven ticks definitely ran.
    expect(res.status).toBe(200);

    // Core assertion: no `notifyPlaybackTimestamp` call landed on the
    // renderer AFTER `stop()` ran. `tickCountAtStop` is the length of
    // `ticks` at the moment the disable handler called `renderer.stop()`;
    // if any tick fires after that point, the bridge wasn't severed.
    //
    // Because the current-reference guard also trips on any tick
    // between `/avatar/disable` setting `avatarRenderer = null` and
    // `renderer.stop()` running (the disable handler runs teardown in
    // sequence), we also assert against the ticks snapshot taken right
    // after the disable response returned.
    expect(renderer.ticks.length).toBe(renderer.tickCountAtStop);
    expect(renderer.ticks.length).toBe(ticksRightAfterDisable);

    // Sanity: some ticks did fire before disable — otherwise the test
    // degenerates into asserting against zero activity on both sides.
    expect(ticksBeforeDisable).toBeGreaterThanOrEqual(1);
  });
});
