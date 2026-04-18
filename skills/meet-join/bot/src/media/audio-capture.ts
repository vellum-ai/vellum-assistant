/**
 * Audio capture for the meet-bot.
 *
 * Spawns `parec` against the `meet_capture.monitor` Pulse source (set up by
 * `pulse-setup.sh` in PR 5), chunks the raw PCM stream into fixed-size
 * frames, and writes those frames into a Unix socket whose server end is
 * opened by the daemon (`MeetAudioIngest`, PR 16) on the host. The socket
 * path is bind-mounted into the container so the bot can connect as a
 * client.
 *
 * Defaults are tuned for Deepgram's realtime STT: s16le mono 16kHz with
 * 20ms frames (320 bytes = 160 samples * 2 bytes). Callers can override the
 * rate/frame size for other consumers (e.g. Whisper streaming).
 *
 * Transient failures — `parec` crashing, the socket dropping, the daemon
 * not yet listening — are absorbed with a bounded retry loop. After 3
 * consecutive failed attempts to re-establish the pipeline we surface the
 * accumulated error via `stop()`'s rejection (and via the optional
 * `onError` callback for async observation).
 *
 * The implementation is structured around injectable `spawn` / `connect`
 * factories so the unit tests can exercise the chunking, reconnect, and
 * error paths without shelling out to a real `parec` or opening a real
 * socket. The defaults point at `Bun.spawn` + `net.createConnection`.
 */

import type { Subprocess } from "bun";
import {
  createConnection as netCreateConnection,
  type Socket as NetSocket,
} from "node:net";

/**
 * Default Pulse source the bot taps for the meeting's audio. `meet_capture`
 * is a null-sink provisioned by `pulse-setup.sh`; its `.monitor` side is
 * where Chrome's playback lands and where we siphon PCM from.
 */
export const DEFAULT_SOURCE_DEVICE = "meet_capture.monitor";

/** s16le mono 16kHz matches Deepgram's realtime ingest format. */
export const DEFAULT_RATE_HZ = 16_000;

/**
 * 20ms at 16kHz, s16le, mono = 160 samples * 2 bytes = 320 bytes. This is
 * Deepgram's recommended realtime frame size.
 */
export const DEFAULT_FRAME_BYTES = 320;

const MAX_RECONNECT_ATTEMPTS = 3;
const RECONNECT_BACKOFF_MS = 500;

/**
 * Minimum number of frames that must flow through the socket in a single
 * attempt before we consider the pipeline "stable" and reset the reconnect
 * budget. At the default 20ms/frame this is ~2s of audio — enough that a
 * pathologically flapping PulseAudio (crashing shortly after each startup
 * and emitting a single frame in between) can no longer keep the budget
 * perpetually topped up. Below this threshold a single-frame attempt still
 * counts as a failure.
 */
const MIN_FRAMES_TO_RESET_BUDGET = 100;

export interface AudioCaptureOptions {
  /**
   * Absolute path to the Unix socket the daemon is listening on. The daemon
   * owns the server end; the bot is the client.
   */
  socketPath: string;
  /**
   * Pulse source to capture from. Defaults to the monitor of the
   * `meet_capture` null-sink created by `pulse-setup.sh`.
   */
  sourceDevice?: string;
  /** Sample rate in Hz. Defaults to 16000. */
  rateHz?: number;
  /**
   * Frame size in bytes. `parec`'s stdout is accumulated until this many
   * bytes are buffered, then flushed to the socket as a single write.
   * Defaults to 320 bytes (20ms at 16kHz mono 16-bit).
   */
  frameBytes?: number;
  /**
   * Optional async error observer. Fired once — when the capture gives up
   * after exhausting the reconnect budget. `stop()` will also reject with
   * the same error, so callbacks are not required.
   */
  onError?: (err: Error) => void;
  /**
   * Test hook — factory matching `Bun.spawn`'s shape, used to spawn `parec`.
   * Left unset in production so we use Bun directly.
   */
  spawn?: SpawnFactory;
  /**
   * Test hook — factory matching `net.createConnection`'s shape, used to
   * open the client socket. Left unset in production so we use Node's net.
   */
  connect?: ConnectFactory;
}

export interface AudioCaptureHandle {
  /**
   * Stop the capture pipeline. Sends SIGTERM to `parec`, ends the socket,
   * and resolves once both have settled. If the pipeline previously
   * exhausted its reconnect budget and ended in an error, this rejects
   * with that error (so callers can `await handle.stop()` and catch).
   */
  stop(): Promise<void>;
}

/**
 * Minimal slice of `Bun.spawn`'s return type that `startAudioCapture`
 * actually uses. Tests can satisfy this without implementing the full
 * `Subprocess` surface.
 */
export interface SpawnedParec {
  /** Readable stream of raw PCM bytes from `parec`'s stdout. */
  stdout: ReadableStream<Uint8Array> | null;
  /** Settles with the child's exit code. */
  exited: Promise<number>;
  /** Send a signal to the child. SIGTERM on clean shutdown. */
  kill(signal?: number | NodeJS.Signals): void;
}

export type SpawnFactory = (argv: readonly string[]) => SpawnedParec;

/**
 * Minimal slice of `net.Socket` that `startAudioCapture` relies on. Tests
 * provide a shim with just these members so we don't need a real kernel
 * socket.
 *
 * The `on` overload intentionally uses a union event + any-listener shape
 * instead of Node's exact overloads: this keeps the shim declaration in
 * test code a single-line object literal rather than forcing the test
 * harness to mirror Node's event-map types.
 */
export interface CapturedSocket {
  /** Enqueue bytes to be written. Must return `true`/`false` per Node's API. */
  write(chunk: Uint8Array): boolean;
  /** Half-close the writable side, causing the server to see EOF. */
  end(): void;
  /** Force-close (optional — tests may no-op). */
  destroy(): void;
  /**
   * Subscribe to `error` / `close` events. The listener receives an
   * `Error` for `"error"` and no arguments for `"close"` — callers are
   * expected to branch on the event name themselves.
   */
  on(
    event: "error" | "close",
    listener: (err?: NodeJS.ErrnoException) => void,
  ): void;
}

export type ConnectFactory = (socketPath: string) => CapturedSocket;

/** Default spawn factory — delegates to `Bun.spawn` with the parec flags. */
function defaultSpawn(argv: readonly string[]): SpawnedParec {
  const proc: Subprocess = Bun.spawn(argv as string[], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "inherit",
  });
  return {
    stdout: proc.stdout as ReadableStream<Uint8Array> | null,
    exited: proc.exited,
    kill: (signal) => proc.kill(signal ?? "SIGTERM"),
  };
}

/** Default connect factory — a Node `net.createConnection` over a Unix path. */
function defaultConnect(socketPath: string): CapturedSocket {
  const sock: NetSocket = netCreateConnection({ path: socketPath });
  return {
    write: (chunk) => sock.write(chunk),
    end: () => sock.end(),
    destroy: () => sock.destroy(),
    on(event, listener) {
      if (event === "error") {
        sock.on("error", (err: NodeJS.ErrnoException) => listener(err));
      } else {
        sock.on("close", () => listener());
      }
    },
  };
}

function buildParecArgv(
  sourceDevice: string,
  rateHz: number,
): readonly string[] {
  return [
    "parec",
    `--device=${sourceDevice}`,
    "--format=s16le",
    `--rate=${rateHz}`,
    "--channels=1",
    "--raw",
  ];
}

/**
 * Start capturing meeting audio and forwarding it to the daemon.
 *
 * On success, returns a handle with a `stop()` method. The pipeline keeps
 * running (and auto-reconnects on transient failures) until the caller
 * invokes `stop()` or the reconnect budget is exhausted.
 */
export async function startAudioCapture(
  opts: AudioCaptureOptions,
): Promise<AudioCaptureHandle> {
  const sourceDevice = opts.sourceDevice ?? DEFAULT_SOURCE_DEVICE;
  const rateHz = opts.rateHz ?? DEFAULT_RATE_HZ;
  const frameBytes = opts.frameBytes ?? DEFAULT_FRAME_BYTES;
  const spawn = opts.spawn ?? defaultSpawn;
  const connect = opts.connect ?? defaultConnect;
  const onError = opts.onError;

  if (frameBytes <= 0) {
    throw new Error(
      `startAudioCapture: frameBytes must be > 0, got ${frameBytes}`,
    );
  }

  const argv = buildParecArgv(sourceDevice, rateHz);

  // Capture state — shared across the retry loop.
  let stopping = false;
  let fatalError: Error | null = null;
  let currentProc: SpawnedParec | null = null;
  let currentSocket: CapturedSocket | null = null;

  // Wakeup channel fired when `stop()` is called — lets the inner attempt
  // loop race against a stop signal without polling.
  let fireStopSignal!: () => void;
  const stopSignal = new Promise<void>((resolve) => {
    fireStopSignal = resolve;
  });

  // Resolves once the retry loop has fully wound down (either after a
  // user-initiated `stop()` or after exhausting the retry budget). `stop()`
  // awaits this so the caller can block until everything is torn down.
  let loopDone!: () => void;
  const loopDonePromise = new Promise<void>((resolve) => {
    loopDone = resolve;
  });

  /**
   * Single pipeline attempt: spawn parec, open the socket, pipe stdout
   * through a frame chunker into the socket, and resolve with a tag
   * describing how the attempt ended.
   *
   * - "stopped"   — the caller invoked `stop()`; we tore things down cleanly.
   * - "parec"     — parec exited (non-stop), caller should retry.
   * - "socket"    — socket errored/closed (non-stop), caller should retry.
   */
  type AttemptOutcome = "stopped" | "parec" | "socket";

  async function runOneAttempt(): Promise<{
    outcome: AttemptOutcome;
    error?: Error;
    framesWritten: number;
  }> {
    let attemptError: Error | undefined;

    // 1. Spawn parec.
    let proc: SpawnedParec;
    try {
      proc = spawn(argv);
    } catch (err) {
      return {
        outcome: "parec",
        error: err instanceof Error ? err : new Error(String(err)),
        framesWritten: 0,
      };
    }
    currentProc = proc;

    // 2. Connect to the daemon socket.
    let sock: CapturedSocket;
    try {
      sock = connect(opts.socketPath);
    } catch (err) {
      // Socket open failed synchronously — kill parec and report.
      try {
        proc.kill("SIGTERM");
      } catch {
        // Process may already be gone; fine.
      }
      return {
        outcome: "socket",
        error: err instanceof Error ? err : new Error(String(err)),
        framesWritten: 0,
      };
    }
    currentSocket = sock;

    // 3. Wait for either parec to exit, the socket to die, or `stop()`.
    const stoppedP = stopSignal.then(() => "stopped" as const);

    const parecExitedP = proc.exited.then((code) => {
      if (code !== 0 && !stopping) {
        attemptError = new Error(`parec exited with code ${code}`);
      }
      return "parec" as const;
    });

    const socketDeadP = new Promise<"socket">((resolve) => {
      sock.on("error", (err) => {
        if (!stopping && err) {
          attemptError = err instanceof Error ? err : new Error(String(err));
        }
        resolve("socket");
      });
      sock.on("close", () => {
        resolve("socket");
      });
    });

    // 4. Pipe parec.stdout through the frame chunker into the socket.
    // We deliberately don't `await` the pump — it races against the three
    // promises above and terminates when any of them settles.
    let framesWritten = 0;
    const pumpDone = pumpFrames(
      proc.stdout,
      sock,
      frameBytes,
      () => stopping,
      () => {
        framesWritten += 1;
      },
    );

    const raceOutcome = await Promise.race([
      stoppedP,
      parecExitedP,
      socketDeadP,
    ]);
    // If `stop()` fired concurrently with a parec/socket event, the race
    // winner is non-deterministic — force-classify as "stopped" so the
    // orchestrator doesn't count a user-initiated teardown as a retry
    // failure.
    const outcome: AttemptOutcome = stopping ? "stopped" : raceOutcome;

    // 5. Tear down whichever side is still alive.
    try {
      proc.kill("SIGTERM");
    } catch {
      // Already dead — fine.
    }
    try {
      sock.end();
    } catch {
      // Already closed — fine.
    }
    try {
      sock.destroy();
    } catch {
      // Ditto.
    }

    // 6. Wait for the pump to drain so we don't leave dangling reads.
    try {
      await pumpDone;
    } catch {
      // Pump errors are already accounted for via the socket/parec paths.
    }

    // 7. Make sure parec has fully exited before we return (so the next
    //    attempt starts from a clean slate).
    try {
      await proc.exited;
    } catch {
      // Shouldn't throw; paranoia.
    }

    currentProc = null;
    currentSocket = null;

    if (outcome === "stopped") {
      return { outcome: "stopped", framesWritten };
    }
    return { outcome, error: attemptError, framesWritten };
  }

  /**
   * Orchestrator: runs attempts until we either stop cleanly or exceed the
   * reconnect budget. Populates `fatalError` on budget exhaustion so
   * `stop()` can surface it.
   */
  async function runLoop(): Promise<void> {
    let consecutiveFailures = 0;

    while (!stopping) {
      const { outcome, error, framesWritten } = await runOneAttempt();

      if (outcome === "stopped") {
        break;
      }

      // Reset the failure counter only if this attempt streamed enough data
      // to look genuinely healthy. A single 320-byte frame would otherwise
      // let pathological flapping (e.g. PulseAudio crashing moments after
      // each startup) keep the reconnect budget perpetually topped up.
      if (framesWritten >= MIN_FRAMES_TO_RESET_BUDGET) {
        consecutiveFailures = 0;
      }

      consecutiveFailures += 1;
      if (consecutiveFailures > MAX_RECONNECT_ATTEMPTS) {
        fatalError =
          error ??
          new Error(
            `audio-capture: exceeded ${MAX_RECONNECT_ATTEMPTS} reconnect attempts`,
          );
        break;
      }

      // Backoff before the next attempt. Break early if stop() fires
      // during the sleep so the caller doesn't have to wait 500ms.
      await Promise.race([
        new Promise<void>((r) => setTimeout(r, RECONNECT_BACKOFF_MS)),
        stopSignal,
      ]);
    }

    if (fatalError && onError) {
      try {
        onError(fatalError);
      } catch {
        // Callback errors are not our problem to propagate further.
      }
    }
    loopDone();
  }

  // Kick off the first attempt synchronously before returning so callers
  // see "parec is spawned" as part of `startAudioCapture`'s successful
  // resolution. If the very first spawn throws, the loop will surface it
  // via stop() just like any other failure.
  void runLoop();

  const stop = async (): Promise<void> => {
    if (!stopping) {
      stopping = true;
      // Wake the attempt loop so it stops racing on parec/socket events.
      fireStopSignal();
      // Proactively tear down whatever's still alive so we don't have to
      // wait for the attempt's internal race to time-slice back.
      const proc = currentProc;
      const sock = currentSocket;
      if (proc) {
        try {
          proc.kill("SIGTERM");
        } catch {
          // Best-effort.
        }
      }
      if (sock) {
        try {
          sock.end();
        } catch {
          // Best-effort.
        }
        try {
          sock.destroy();
        } catch {
          // Best-effort.
        }
      }
    }
    await loopDonePromise;
    if (fatalError) {
      throw fatalError;
    }
  };

  return { stop };
}

/**
 * Drain `stdout` through a frame chunker, flushing full frames into the
 * socket. `frameBytes` must be > 0 (validated upstream). Partial tails are
 * held in memory until the next chunk completes them; any trailing partial
 * at EOF is dropped (undersized frames would confuse a downstream decoder
 * expecting fixed-size PCM).
 *
 * Writes are plain `Uint8Array`s — we copy from the buffered arena so we
 * don't hand the socket a slice that could later be overwritten by
 * subsequent reads.
 */
async function pumpFrames(
  stdout: ReadableStream<Uint8Array> | null,
  sock: CapturedSocket,
  frameBytes: number,
  isStopping: () => boolean,
  onFrame?: () => void,
): Promise<void> {
  if (!stdout) return;
  const reader = stdout.getReader();

  // Accumulator for partial frames. We avoid per-chunk allocations of
  // `frameBytes` by growing this only when needed.
  let buffer = new Uint8Array(0);

  try {
    while (!isStopping()) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value || value.length === 0) continue;

      // Append the new chunk. For a small buffer this is cheap; a zero-copy
      // chain would be faster but premature here — 20ms frames at 16kHz
      // are 320 bytes, well inside memcpy-is-fine territory.
      const next = new Uint8Array(buffer.length + value.length);
      next.set(buffer, 0);
      next.set(value, buffer.length);
      buffer = next;

      // Flush complete frames.
      while (buffer.length >= frameBytes && !isStopping()) {
        const frame = buffer.slice(0, frameBytes);
        buffer = buffer.slice(frameBytes);
        try {
          sock.write(frame);
          onFrame?.();
        } catch {
          // Socket write failure aborts the pump; the outer attempt loop
          // will pick it up via the socket's `error`/`close` handlers.
          return;
        }
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // releaseLock is a no-op if the stream is already closed.
    }
  }
}
