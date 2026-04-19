/**
 * Audio playback for the meet-bot.
 *
 * Spawns `pacat --playback` against the `bot_out` Pulse null-sink (set up by
 * `pulse-setup.sh`); Chrome's microphone is wired to `bot_out.monitor`, so
 * any PCM we push into pacat's stdin shows up as the bot's voice inside the
 * Meet tab.
 *
 * Public surface:
 *   - `startAudioPlayback()` — idempotent. Returns a writable handle. If a
 *     previous pacat is still alive, the same handle is returned so
 *     concurrent playback calls don't fight over who spawned the process.
 *   - `stopAudioPlayback()` — closes the current handle, kills pacat, and
 *     resets the module-level singleton. Safe to call repeatedly.
 *   - `flushSilence(ms)` — writes `ms * bytesPerMs` zero-valued bytes into
 *     the active handle. Used to cleanly terminate a stream without the
 *     characteristic "pop" caused by a sudden cut-off.
 *
 * Defaults match what the daemon sends: s16le mono 48kHz. That rate is
 * chosen to match Meet's WebRTC pipeline so the null-sink resampler has no
 * work to do.
 *
 * Like `audio-capture`, the module accepts an injected `spawn` factory so
 * tests can exercise ordering, cancellation, and silence-flush behavior
 * without ever shelling out to a real `pacat`. The default factory calls
 * `Bun.spawn`.
 */

import type { Subprocess } from "bun";

/** Pulse sink where Chrome will pick up our playback. */
export const DEFAULT_PLAYBACK_DEVICE = "bot_out";

/** 48kHz s16le mono — matches WebRTC. */
export const DEFAULT_RATE_HZ = 48_000;
export const DEFAULT_CHANNELS = 1;
/** s16le = 2 bytes/sample. */
export const DEFAULT_SAMPLE_BYTES = 2;

/**
 * Bytes of PCM per millisecond at the default format.
 * 48000 samples/s * 1 channel * 2 bytes = 96 bytes/ms.
 */
export const DEFAULT_BYTES_PER_MS =
  (DEFAULT_RATE_HZ * DEFAULT_CHANNELS * DEFAULT_SAMPLE_BYTES) / 1000;

/**
 * Minimal slice of `Bun.spawn`'s return type that playback actually needs.
 * Tests can satisfy this with a shim whose stdin captures writes into a
 * buffer.
 */
export interface SpawnedPacat {
  /** Writable end of pacat's stdin. Accepts raw PCM. */
  stdin: PacatWritable;
  /** Settles once pacat exits. */
  exited: Promise<number>;
  /** Send a signal — SIGTERM on clean shutdown. */
  kill(signal?: number | NodeJS.Signals): void;
}

/**
 * The subset of a writable stream we rely on. Matches both Node's
 * `Writable` and `FileSink` (returned by `Bun.spawn`'s `stdin: "pipe"`).
 *
 * `write` is allowed to return synchronously (Node) or as a promise
 * (FileSink); the caller always `await`s it.
 */
export interface PacatWritable {
  write(chunk: Uint8Array): number | Promise<number | void> | void | boolean;
  end?: () => void | Promise<void>;
}

export type PacatSpawnFactory = (argv: readonly string[]) => SpawnedPacat;

/**
 * Options for `startAudioPlayback`. In production all fields default to
 * reasonable values; tests typically override `spawn`.
 */
export interface StartAudioPlaybackOptions {
  device?: string;
  rateHz?: number;
  channels?: number;
  spawn?: PacatSpawnFactory;
  /**
   * Override the wall-clock source for playback-timestamp estimation.
   * Tests pass a deterministic clock so they can advance time in
   * controlled increments without real delays. Production uses
   * `performance.now()`.
   */
  now?: () => number;
}

/**
 * Writable handle backed by an active `pacat` process.
 *
 * `write` returns once the bytes have been handed to pacat (its stdin may
 * apply backpressure via a promise resolution). `flushSilence` pushes a
 * block of zeroes — typically 50ms at shutdown to avoid a popping sound.
 *
 * `onPlaybackTimestamp` exposes an estimate of the wall-clock time at
 * which the most recently written PCM byte will play out of the
 * `bot_out` sink. Consumers subscribe to this stream to align
 * audio-adjacent pipelines (e.g. the TalkingHead.js renderer aligning
 * viseme emission to audio) with the actual playback timeline rather
 * than with the time visemes are received from the daemon.
 *
 * The estimate is derived from
 *   `max(nowMs, lastEstimate) + byteCount / bytesPerMs`
 * so that sustained writes accumulate into the future (keeping track
 * of buffered audio) while a write after the buffer has drained snaps
 * back to real time. Because Chrome → PulseAudio → `bot_out` → WebRTC
 * resampler is all zero-copy for matching sample rates, the dominant
 * latency source is the ~10 ms pacat jitter buffer; the estimate is
 * therefore accurate to roughly ±30 ms.
 */
export interface AudioPlaybackHandle {
  /** Whether this handle is still usable. Flips to `false` on stop. */
  readonly active: boolean;
  /** The argv pacat was spawned with. Useful for debugging/logging. */
  readonly argv: readonly string[];
  /** Bytes of PCM per millisecond at this handle's configured format. */
  readonly bytesPerMs: number;
  /** Write raw PCM bytes to pacat's stdin. */
  write(chunk: Uint8Array): Promise<void>;
  /** Write `ms` milliseconds of silence (zero bytes). */
  flushSilence(ms: number): Promise<void>;
  /**
   * Subscribe to playback-timestamp updates. The callback fires after
   * every non-empty byte write (including silence flushes) with the
   * wall-clock time at which the most recently written PCM byte is
   * expected to play out of the sink. Returns an unsubscribe function;
   * calling it more than once is a no-op.
   *
   * Timestamps are strictly monotonic: each emission advances the clock
   * by at least `byteCount / bytesPerMs` past the previous emission, so
   * subscribers can compare directly with `VisemeEvent.timestamp`
   * values without worrying about equal-timestamp reordering.
   */
  onPlaybackTimestamp(cb: (ts: number) => void): () => void;
}

/**
 * Default monotonic clock — `performance.now()` gives millisecond-
 * resolution wall-clock time that tracks the same reference as the
 * `VisemeEvent.timestamp` field the daemon stamps on outbound viseme
 * events, so the alignment math works without coordinate-system
 * translation.
 */
function defaultNow(): number {
  return performance.now();
}

/** Default spawn factory — wraps `Bun.spawn` with the pacat flags. */
function defaultSpawn(argv: readonly string[]): SpawnedPacat {
  const proc: Subprocess<"pipe", "pipe", "pipe"> = Bun.spawn(argv as string[], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    stdin: proc.stdin as unknown as PacatWritable,
    exited: proc.exited,
    kill: (signal) => proc.kill(signal ?? "SIGTERM"),
  };
}

function buildPacatArgv(
  device: string,
  rateHz: number,
  channels: number,
): readonly string[] {
  return [
    "pacat",
    "--playback",
    `--device=${device}`,
    "--format=s16le",
    `--rate=${rateHz}`,
    `--channels=${channels}`,
    "--raw",
  ];
}

interface ActivePlayback {
  proc: SpawnedPacat;
  handle: AudioPlaybackHandle;
  markDead: () => void;
}

/**
 * Module-level singleton — we only ever run one pacat at a time. Sharing
 * the sink across concurrent playbacks is a daemon concern (mixing), not
 * the bot's: the bot just needs to stream whatever PCM arrives in order.
 */
let active: ActivePlayback | null = null;

/**
 * Start (or reuse) the playback pipeline. Returns an `AudioPlaybackHandle`
 * that callers write PCM into. Idempotent — if pacat is already running,
 * the existing handle is returned verbatim so callers don't race on spawn.
 */
export function startAudioPlayback(
  opts: StartAudioPlaybackOptions = {},
): AudioPlaybackHandle {
  if (active !== null) {
    return active.handle;
  }

  const device = opts.device ?? DEFAULT_PLAYBACK_DEVICE;
  const rateHz = opts.rateHz ?? DEFAULT_RATE_HZ;
  const channels = opts.channels ?? DEFAULT_CHANNELS;
  const spawn = opts.spawn ?? defaultSpawn;
  const now = opts.now ?? defaultNow;
  const bytesPerMs = (rateHz * channels * DEFAULT_SAMPLE_BYTES) / 1000;

  const argv = buildPacatArgv(device, rateHz, channels);
  const proc = spawn(argv);

  let alive = true;
  const markDead = () => {
    alive = false;
  };

  // If pacat exits on its own, drop the singleton so the next
  // `startAudioPlayback` call respawns it instead of handing back a dead
  // handle.
  void proc.exited.then(() => {
    markDead();
    if (active && active.proc === proc) {
      active = null;
    }
  });

  // --- playback-timestamp state ---------------------------------------
  //
  // `effectivePlaybackMs` is the wall-clock time at which the most
  // recently queued PCM byte is expected to play out. After every
  // write we advance it by `byteCount / bytesPerMs` from either the
  // current `effectivePlaybackMs` (buffer still has data) or from
  // `now()` (buffer drained between writes) — whichever is later.
  //
  // This matches the way the kernel's snd-aloop / PulseAudio scheduler
  // model sink latency. Our error bound is dominated by pacat's
  // internal jitter buffer (~10 ms) and the Pulse null-sink (~0 ms),
  // so the estimate stays well under the 30 ms accuracy target.
  let effectivePlaybackMs = now();
  const timestampSubscribers: Array<(ts: number) => void> = [];

  const emitTimestamp = (): void => {
    // Copy the list so an unsubscribe during dispatch doesn't skip a
    // neighbor.
    for (const cb of timestampSubscribers.slice()) {
      try {
        cb(effectivePlaybackMs);
      } catch {
        // Subscriber threw; swallow so audio playback stays healthy.
      }
    }
  };

  const advanceAfterWrite = (byteCount: number): void => {
    if (byteCount <= 0) return;
    const nowMs = now();
    // If the buffer has fully drained since the last write (i.e. real
    // time has moved past our previous estimate), rebase to now — the
    // newly-written bytes play "now-ish", not at a stale pinned clock.
    const baseline = Math.max(nowMs, effectivePlaybackMs);
    effectivePlaybackMs = baseline + byteCount / bytesPerMs;
    emitTimestamp();
  };

  const handle: AudioPlaybackHandle = {
    get active() {
      return alive;
    },
    argv,
    bytesPerMs,
    async write(chunk: Uint8Array): Promise<void> {
      if (!alive) {
        throw new Error("audio-playback: write to inactive handle");
      }
      if (chunk.length === 0) return;
      const result = proc.stdin.write(chunk);
      if (result && typeof (result as Promise<unknown>).then === "function") {
        await result;
      }
      advanceAfterWrite(chunk.length);
    },
    async flushSilence(ms: number): Promise<void> {
      if (!alive) return;
      if (ms <= 0) return;
      const total = Math.floor(ms * bytesPerMs);
      if (total <= 0) return;
      // Write silence in a single allocation — 50ms at 48kHz mono is only
      // 4800 bytes, comfortably small.
      const silence = new Uint8Array(total); // zero-filled by default
      await this.write(silence);
    },
    onPlaybackTimestamp(cb: (ts: number) => void): () => void {
      timestampSubscribers.push(cb);
      let unsubscribed = false;
      return () => {
        if (unsubscribed) return;
        unsubscribed = true;
        const idx = timestampSubscribers.indexOf(cb);
        if (idx !== -1) timestampSubscribers.splice(idx, 1);
      };
    },
  };

  active = { proc, handle, markDead };
  return handle;
}

/**
 * Stop the current pacat process (if any). Safe to call when nothing is
 * running. Awaits the process exit so callers can sequence teardown.
 */
export async function stopAudioPlayback(): Promise<void> {
  const current = active;
  if (current === null) return;
  active = null;
  current.markDead();
  try {
    await current.proc.stdin.end?.();
  } catch {
    // Best-effort — if stdin is already closed, that's fine.
  }
  try {
    current.proc.kill("SIGTERM");
  } catch {
    // Best-effort — process may already be gone.
  }
  try {
    await current.proc.exited;
  } catch {
    // Exit shouldn't throw; paranoia.
  }
}

/**
 * Convenience — `flushSilence` through the currently-active handle. If no
 * handle is active this is a no-op.
 */
export async function flushSilence(ms: number): Promise<void> {
  const current = active;
  if (current === null) return;
  await current.handle.flushSilence(ms);
}

/**
 * Test-only: peek at the currently-active handle (or `null` if none).
 * Exposed so tests can assert singleton behavior.
 */
export function __getActiveHandleForTests(): AudioPlaybackHandle | null {
  return active ? active.handle : null;
}

/**
 * Test-only: force-reset the singleton so tests don't leak state between
 * cases. Does not attempt to kill pacat — use `stopAudioPlayback()` for
 * that.
 */
export function __resetForTests(): void {
  active = null;
}
