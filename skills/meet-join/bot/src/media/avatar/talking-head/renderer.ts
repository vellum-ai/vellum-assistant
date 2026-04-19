/**
 * TalkingHead.js-backed avatar renderer for the meet-bot.
 *
 * TalkingHead.js (`@met4citizen/talkinghead` on npm) renders a Ready
 * Player Me GLB avatar in a WebGL/three.js canvas and drives lip-sync
 * from viseme events. Because TalkingHead.js requires a real browser
 * runtime (three.js needs a `<canvas>`, a WebGL context, and an
 * `AnimationFrame` loop), the renderer itself lives **inside a second
 * Chrome tab** inside the meet-bot's Chrome process, not in the
 * bot's Node runtime.
 *
 * Responsibilities of this bot-side renderer:
 *
 * 1. On `start()`: send `avatar.start` over the native-messaging bridge
 *    to the meet-controller extension. The extension opens the avatar
 *    tab (see `meet-controller-ext/src/features/avatar.ts`) and replies
 *    with `avatar.started` once the tab has mounted.
 *
 *    We bound the wait for that ack with a configurable timeout
 *    (default 5 s). On timeout we throw
 *    {@link AvatarRendererUnavailableError} so the session-manager can
 *    fall back to the noop renderer without crashing the meeting.
 *
 * 2. On `pushViseme(event)`: forward the event to the extension as
 *    `avatar.push_viseme`. The extension relays the event into the
 *    avatar tab via `chrome.tabs.sendMessage`.
 *
 * 3. On inbound `avatar.frame` from the extension: base64-decode the
 *    payload. If the frame is JPEG, transcode it to Y4M via a
 *    short-lived ffmpeg child; if it's already Y4M, emit the bytes
 *    directly. Downstream: {@link attachDeviceWriter} forwards the
 *    Y4M bytes to `/dev/video10`.
 *
 * 4. On `stop()`: send `avatar.stop`, tear down the ffmpeg child, and
 *    dispose the native-messaging channel so late frames after
 *    shutdown are dropped at the channel layer. Idempotent.
 *
 * ## Audio / viseme handling
 *
 * TalkingHead.js lip-syncs from discrete viseme events. This renderer
 * advertises `{ needsVisemes: true, needsAudio: true }`:
 *
 * - Incoming viseme events are BUFFERED by the renderer and only
 *   forwarded to the extension once the audio-playback clock catches
 *   up to each viseme's declared `timestamp`. This removes visible
 *   drift caused by network jitter between the daemon and the bot:
 *   a viseme that arrives 100ms before its audio lands is held until
 *   the audio actually plays, then released.
 * - `notifyPlaybackTimestamp(ts)` advances the internal playback
 *   clock. The bot's HTTP server wires the audio-playback handle's
 *   `onPlaybackTimestamp` stream to this method so every PCM write
 *   into `bot_out` bumps the renderer's clock forward.
 * - `pushAudio` is accepted for interface conformance but is a no-op.
 *   The renderer derives all timing information from the
 *   playback-timestamp stream, not from direct audio chunks.
 *
 * ## Frame transcoding
 *
 * JPEG → Y4M conversion runs through a short-lived ffmpeg child per
 * frame. This is the simplest correct implementation — the frame is
 * written to ffmpeg's stdin, Y4M is read off its stdout, and the child
 * exits. It's also the slowest: a sustained stream at 24 fps spawns
 * 24 subprocesses per second which is inefficient. A future
 * optimization is to keep a long-lived ffmpeg child with a persistent
 * Y4M input stream; we defer that complexity to a later PR because:
 *
 * - v1 ships at 20–24 fps, which is still well under the 30 fps
 *   device-writer cap and well within what per-frame spawning can
 *   sustain on a modest bot VM.
 * - The alignment math PR 9 introduces may change the frame-ingress
 *   contract entirely; premature optimization would be wasted work.
 *
 * The Y4M-input path skips ffmpeg entirely — the extension may
 * eventually capture raw Y4M via a future `canvas.captureStream()`
 * → MediaRecorder pipeline. v1 always uses JPEG.
 *
 * ## Why a second tab?
 *
 * We can't host TalkingHead.js in the Meet tab itself — Meet's CSP
 * and its aggressive DOM virtualization would fight with three.js.
 * Running it in a pinned, inactive second tab isolates it: the user
 * never sees the tab (it lives on the Xvfb virtual display), but
 * Chrome still budgets it real GPU time as long as the extension
 * marks it `pinned` to avoid tab-discard.
 */

import type { Subprocess } from "bun";

import type {
  AvatarRenderer,
  AvatarCapabilities,
  VisemeEvent,
  Y4MFrame,
} from "../types.js";
import { AvatarRendererUnavailableError } from "../types.js";
import {
  createAvatarChannel,
  type AvatarChannel,
} from "../../../native-messaging/avatar-channel.js";
import type { AvatarNativeMessagingSender } from "../registry.js";

/** Stable renderer id; shared with the registry/factory key. */
export const TALKING_HEAD_RENDERER_ID = "talking-head";

/** Capability flags the renderer advertises. */
export const TALKING_HEAD_CAPABILITIES: AvatarCapabilities = {
  needsVisemes: true,
  needsAudio: true,
};

/** Default bounded wait for the extension's `avatar.started` ack. */
export const DEFAULT_STARTED_ACK_TIMEOUT_MS = 5_000;

/** Default advisory FPS hint sent to the extension on `avatar.start`. */
export const DEFAULT_TARGET_FPS = 24;

/**
 * JPEG → Y4M spawn factory. Production calls `Bun.spawn(["ffmpeg", ...])`
 * but tests inject a fake so the transcode path can be exercised without
 * ffmpeg on the test host.
 *
 * Contract: the factory returns a child that accepts the JPEG bytes on
 * stdin and emits one Y4M frame on stdout. The renderer waits for the
 * child's `exited` promise before emitting the frame so partial stdout
 * reads cannot produce a truncated Y4M blob.
 */
export type JpegToY4mSpawnFactory = (jpegBytes: Uint8Array) => {
  /** Read and concatenate the entire stdout as Y4M bytes. */
  readY4m: () => Promise<Uint8Array>;
  /** Resolve when the child has exited. */
  exited: Promise<number>;
  /** Kill the child if still running. Idempotent. */
  kill: () => void;
};

export interface TalkingHeadRendererOptions {
  /**
   * The native-messaging surface the renderer drives. When absent the
   * factory throws {@link AvatarRendererUnavailableError} so the
   * HTTP layer returns 503 instead of crashing the meeting.
   */
  nativeMessaging?: AvatarNativeMessagingSender;
  /**
   * Advisory target FPS forwarded to the extension in `avatar.start`.
   * Defaults to {@link DEFAULT_TARGET_FPS}. The bot re-applies its own
   * FPS cap at the device-writer layer; this value only sizes the
   * avatar tab's `requestAnimationFrame` capture cadence.
   */
  targetFps?: number;
  /**
   * Optional URL pointing at a GLB the extension should load. When
   * absent the extension uses the bundled `default-avatar.glb`.
   * Forwarded in the `avatar.start` command.
   */
  modelUrl?: string;
  /**
   * Time in milliseconds to wait for the `avatar.started` ack before
   * throwing {@link AvatarRendererUnavailableError}. Defaults to
   * {@link DEFAULT_STARTED_ACK_TIMEOUT_MS}. Tests shrink this to
   * millisecond scale.
   */
  startedAckTimeoutMs?: number;
  /**
   * JPEG → Y4M transcoder factory. Defaults to a real Bun.spawn of
   * ffmpeg. Tests inject a fake that echoes a deterministic Y4M blob
   * so the renderer's on-frame path can be asserted without a real
   * ffmpeg.
   */
  spawnJpegToY4m?: JpegToY4mSpawnFactory;
  /** Optional logger — routed to console when omitted. */
  logger?: {
    info(msg: string, extra?: Record<string, unknown>): void;
    warn(msg: string, extra?: Record<string, unknown>): void;
    error(msg: string, extra?: Record<string, unknown>): void;
  };
}

/**
 * Concrete TalkingHead.js renderer. Implements {@link AvatarRenderer}
 * by delegating every interesting operation to the Chrome extension
 * over the native-messaging bridge.
 */
export class TalkingHeadRenderer implements AvatarRenderer {
  readonly id = TALKING_HEAD_RENDERER_ID;
  readonly capabilities = TALKING_HEAD_CAPABILITIES;

  private readonly nativeMessaging: AvatarNativeMessagingSender;
  private readonly targetFps: number;
  private readonly modelUrl: string | undefined;
  private readonly startedAckTimeoutMs: number;
  private readonly spawnJpegToY4m: JpegToY4mSpawnFactory;
  private readonly logger?: TalkingHeadRendererOptions["logger"];

  private channel: AvatarChannel | null = null;
  private started = false;
  private stopped = false;

  /** Active JPEG→Y4M transcodes so shutdown can tear them down. */
  private readonly inFlightTranscodes = new Set<{ kill: () => void }>();

  /** Pending `avatar.started` waiter resolver. Null when not waiting. */
  private startedWaiter:
    | {
        resolve: () => void;
        reject: (err: Error) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    | null = null;

  private subscribers: Array<(frame: Y4MFrame) => void> = [];

  /**
   * Visemes held back until the audio-playback clock catches up to
   * their `timestamp`. Stored in arrival order — the flush step
   * preserves input order while only releasing events whose timestamp
   * is `<= currentPlaybackTimestamp`. A small per-speech burst (say
   * 50-100 visemes at 20 fps over a 2-5 s utterance) keeps this
   * array's working set trivially small; we don't need a heap.
   */
  private readonly visemeBuffer: VisemeEvent[] = [];

  /**
   * The latest playback timestamp observed from the audio-playback
   * stream. `-Infinity` means "no audio has been queued yet" — every
   * viseme is held until the first notification arrives.
   */
  private currentPlaybackTimestamp = Number.NEGATIVE_INFINITY;

  constructor(opts: TalkingHeadRendererOptions) {
    if (!opts.nativeMessaging) {
      throw new AvatarRendererUnavailableError(
        TALKING_HEAD_RENDERER_ID,
        "native-messaging channel not available (renderer requires the bot's NMH socket server)",
      );
    }
    this.nativeMessaging = opts.nativeMessaging;
    this.targetFps = opts.targetFps ?? DEFAULT_TARGET_FPS;
    this.modelUrl = opts.modelUrl;
    this.startedAckTimeoutMs =
      opts.startedAckTimeoutMs ?? DEFAULT_STARTED_ACK_TIMEOUT_MS;
    this.spawnJpegToY4m = opts.spawnJpegToY4m ?? defaultSpawnJpegToY4m;
    this.logger = opts.logger;
  }

  async start(): Promise<void> {
    if (this.stopped) {
      throw new AvatarRendererUnavailableError(
        TALKING_HEAD_RENDERER_ID,
        "renderer already stopped; construct a fresh instance to restart",
      );
    }
    if (this.started) return;
    this.started = true;

    // Set up the inbound listener BEFORE sending `avatar.start` so a
    // very-fast extension can't beat us to the ack.
    this.channel = createAvatarChannel({
      sender: this.nativeMessaging,
      onExtensionMessage: this.nativeMessaging.onExtensionMessage,
      handlers: {
        onStarted: () => {
          this.resolveStartedWaiter();
        },
        onFrame: (msg) => {
          void this.handleFrame(msg);
        },
      },
    });

    // Hand off `avatar.start` and wait for the ack with a bounded
    // timeout. The renderer's start() promise is what the HTTP
    // `/avatar/enable` route awaits, so we can't block indefinitely.
    const waitForAck = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.startedWaiter = null;
        reject(
          new AvatarRendererUnavailableError(
            TALKING_HEAD_RENDERER_ID,
            `extension did not ack avatar.start within ${this.startedAckTimeoutMs}ms`,
          ),
        );
      }, this.startedAckTimeoutMs);
      this.startedWaiter = { resolve, reject, timer };
    });

    try {
      this.channel.start({
        targetFps: this.targetFps,
        ...(this.modelUrl !== undefined ? { modelUrl: this.modelUrl } : {}),
      });
    } catch (err) {
      // Dispatching on a closed socket throws synchronously. Surface
      // it as AvatarRendererUnavailableError so the session-manager
      // can fall back rather than 500.
      if (this.startedWaiter) {
        clearTimeout(this.startedWaiter.timer);
        this.startedWaiter = null;
      }
      const message = err instanceof Error ? err.message : String(err);
      throw new AvatarRendererUnavailableError(
        TALKING_HEAD_RENDERER_ID,
        `failed to dispatch avatar.start: ${message}`,
      );
    }

    await waitForAck;
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;

    // If we're still waiting for the start ack, reject it so a
    // racing stop() unblocks the start() promise cleanly.
    if (this.startedWaiter) {
      clearTimeout(this.startedWaiter.timer);
      this.startedWaiter.reject(
        new AvatarRendererUnavailableError(
          TALKING_HEAD_RENDERER_ID,
          "renderer stopped before extension acknowledged avatar.start",
        ),
      );
      this.startedWaiter = null;
    }

    // Best-effort avatar.stop dispatch. Swallow errors — if the socket
    // server is already gone, the extension will be torn down with
    // Chrome anyway.
    try {
      this.channel?.stop();
    } catch (err) {
      this.logger?.warn?.("talking-head: avatar.stop dispatch failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    this.channel?.dispose();
    this.channel = null;

    // Tear down any ffmpeg transcodes still running so we don't leak
    // child processes on teardown.
    for (const transcode of this.inFlightTranscodes) {
      try {
        transcode.kill();
      } catch {
        // Best-effort.
      }
    }
    this.inFlightTranscodes.clear();

    // Drop any buffered visemes that never made it out. They belonged
    // to a now-stopped session; replaying them against a future
    // renderer would be meaningless.
    this.visemeBuffer.length = 0;

    // Drop every subscriber so late frames (which should not arrive
    // after dispose, but defensively) cannot dispatch.
    this.subscribers = [];
  }

  pushAudio(_pcm: Uint8Array, _ts: number): void {
    // The renderer derives timing information from the playback-
    // timestamp stream (see `notifyPlaybackTimestamp`), not from the
    // raw PCM chunks the daemon pushes. This method remains callable
    // for interface conformance but is a deliberate no-op.
  }

  pushViseme(event: VisemeEvent): void {
    if (!this.channel || this.stopped) return;
    // Hold every viseme until the audio-playback clock catches up to
    // its timestamp. If the audio is already ahead (e.g. the viseme
    // arrived late or the clock was already advanced by an earlier
    // flush), the buffer flush immediately below will drain it
    // synchronously.
    this.visemeBuffer.push(event);
    this.flushBufferedVisemes();
  }

  /**
   * Advance the renderer's playback clock. Called by the audio-
   * playback handle's `onPlaybackTimestamp` stream (wired up by the
   * bot's HTTP server when a playback stream is active). Any buffered
   * visemes whose `timestamp <= ts` are forwarded to the extension in
   * arrival order; the rest remain held until the next notification.
   *
   * This method is safe to call before `start()` (it will only buffer
   * the clock advance) and after `stop()` (no-op — the channel is
   * gone). It is a no-op when `ts` is not greater than the current
   * timestamp, so repeated identical notifications are idempotent.
   */
  notifyPlaybackTimestamp(ts: number): void {
    if (this.stopped) return;
    if (ts <= this.currentPlaybackTimestamp) return;
    this.currentPlaybackTimestamp = ts;
    this.flushBufferedVisemes();
  }

  /**
   * Drain every buffered viseme whose declared `timestamp` is
   * `<= currentPlaybackTimestamp`, forwarding each to the extension in
   * arrival order. Buffered visemes that remain in the future relative
   * to the playback clock stay in place.
   *
   * Kept in a single helper so `pushViseme` and
   * `notifyPlaybackTimestamp` share exactly one dispatch path — making
   * it impossible for the two entry points to diverge on ordering.
   */
  private flushBufferedVisemes(): void {
    if (!this.channel || this.stopped) return;
    if (this.visemeBuffer.length === 0) return;

    // We release from the head of the buffer in arrival order; as
    // soon as we hit a viseme that's still in the future we stop.
    // Visemes with out-of-order timestamps (which the daemon SHOULD
    // never produce, but we guard anyway) are released as soon as
    // they reach the head of the queue — we trust the daemon's
    // ordering over raw timestamp comparison because the extension
    // expects events in the order they were intended to play.
    while (this.visemeBuffer.length > 0) {
      const next = this.visemeBuffer[0]!;
      if (next.timestamp > this.currentPlaybackTimestamp) break;
      this.visemeBuffer.shift();
      try {
        this.channel.pushViseme(next);
      } catch (err) {
        // A disconnected socket is a symptom, not a fatal — the
        // meeting should continue even if lip-sync is dropped.
        this.logger?.warn?.("talking-head: pushViseme dispatch failed", {
          error: err instanceof Error ? err.message : String(err),
          phoneme: next.phoneme,
        });
      }
    }
  }

  onFrame(cb: (frame: Y4MFrame) => void): () => void {
    this.subscribers.push(cb);
    let unsubscribed = false;
    return () => {
      if (unsubscribed) return;
      unsubscribed = true;
      const idx = this.subscribers.indexOf(cb);
      if (idx !== -1) this.subscribers.splice(idx, 1);
    };
  }

  private resolveStartedWaiter(): void {
    if (!this.startedWaiter) return;
    clearTimeout(this.startedWaiter.timer);
    this.startedWaiter.resolve();
    this.startedWaiter = null;
  }

  /**
   * Base64-decode the frame payload, transcode JPEG→Y4M if needed,
   * then dispatch to subscribers. Swallows per-frame errors (with a
   * log) — a single bad frame must not kill the stream.
   */
  private async handleFrame(msg: {
    bytes: string;
    width: number;
    height: number;
    format: "jpeg" | "y4m";
    ts: number;
  }): Promise<void> {
    if (this.stopped) return;

    let rawBytes: Uint8Array;
    try {
      rawBytes = decodeBase64(msg.bytes);
    } catch (err) {
      this.logger?.warn?.("talking-head: frame base64 decode failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    let y4mBytes: Uint8Array;
    if (msg.format === "y4m") {
      y4mBytes = rawBytes;
    } else {
      try {
        y4mBytes = await this.transcodeJpegToY4m(rawBytes);
      } catch (err) {
        this.logger?.warn?.("talking-head: jpeg→y4m transcode failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        return;
      }
    }

    if (this.stopped) return;

    const frame: Y4MFrame = {
      bytes: y4mBytes,
      timestamp: msg.ts,
      width: msg.width,
      height: msg.height,
    };
    // Copy the subscriber list so a mid-dispatch unsubscribe doesn't
    // skip a neighbor.
    for (const cb of this.subscribers.slice()) {
      try {
        cb(frame);
      } catch (err) {
        this.logger?.warn?.("talking-head: onFrame subscriber threw", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /**
   * Spawn a short-lived ffmpeg child to transcode a single JPEG frame
   * to Y4M. Tracks the child in {@link inFlightTranscodes} so stop()
   * can kill it if the renderer is torn down mid-transcode.
   */
  private async transcodeJpegToY4m(jpegBytes: Uint8Array): Promise<Uint8Array> {
    const child = this.spawnJpegToY4m(jpegBytes);
    const trackedChild = { kill: child.kill };
    this.inFlightTranscodes.add(trackedChild);
    try {
      return await child.readY4m();
    } finally {
      this.inFlightTranscodes.delete(trackedChild);
    }
  }
}

/**
 * Default spawn factory — wraps `Bun.spawn` with the ffmpeg flags.
 *
 * Pipes the JPEG bytes into ffmpeg's stdin, reads Y4M off its
 * stdout. The `-f yuv4mpegpipe` output format is the Y4M container;
 * `-pix_fmt yuv420p` matches the v4l2loopback device negotiated in
 * `video-device.ts`.
 */
function defaultSpawnJpegToY4m(jpegBytes: Uint8Array): {
  readY4m: () => Promise<Uint8Array>;
  exited: Promise<number>;
  kill: () => void;
} {
  const proc = Bun.spawn(
    [
      "ffmpeg",
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "image2pipe",
      "-vcodec",
      "mjpeg",
      "-i",
      "pipe:0",
      "-pix_fmt",
      "yuv420p",
      "-f",
      "yuv4mpegpipe",
      "pipe:1",
    ],
    {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  ) as Subprocess<"pipe", "pipe", "pipe">;

  // Write JPEG into stdin and close it so ffmpeg knows there's no
  // more input coming. Without this close, ffmpeg waits on stdin
  // forever and the Y4M output never completes.
  const stdin = proc.stdin as unknown as {
    write(chunk: Uint8Array): unknown;
    end(): unknown;
  };
  stdin.write(jpegBytes);
  stdin.end();

  const readY4m = async (): Promise<Uint8Array> => {
    // Bun.spawn's `stdout` is a ReadableStream of Uint8Array chunks.
    const reader = (proc.stdout as unknown as ReadableStream<Uint8Array>).getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        total += value.byteLength;
      }
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    await proc.exited;
    return out;
  };

  return {
    readY4m,
    exited: proc.exited,
    kill: () => {
      try {
        proc.kill("SIGTERM");
      } catch {
        // Best-effort.
      }
    },
  };
}

/**
 * Decode a base64 string to a Uint8Array. Bun ships `atob` natively
 * so we don't need a dependency, but we wrap the result in a typed
 * array explicitly for clarity.
 */
function decodeBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}
