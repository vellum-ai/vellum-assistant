/**
 * Device writer — pipes an {@link AvatarRenderer}'s Y4M frames into an
 * open {@link VideoDeviceHandle}.
 *
 * Subscribes to the renderer's `onFrame` channel on `start()`. Each
 * arriving frame is rate-limited against a configurable max-FPS cap
 * (default 30 FPS) and then forwarded to the device handle's `sink`.
 * The cap exists because hosted backends (Simli, HeyGen, Tavus) can
 * burst frames faster than the v4l2 ring can consume them — flooding
 * the device risks dropped frames and, in some kernel versions,
 * full-speed buffer overrun errors on the consumer side.
 *
 * Stopping is idempotent: repeated `stop()` calls settle without
 * throwing. `stop()` unsubscribes the renderer listener before
 * returning so a late frame delivered after shutdown cannot reach the
 * sink.
 *
 * This module owns no actual v4l2 configuration — the device handle
 * (`openVideoDevice` from `../video-device.ts`) already negotiated the
 * pixel format. The writer is just the glue between the renderer's
 * frame channel and the kernel-side sink.
 */

import type { AvatarRenderer, Y4MFrame } from "./types.js";

/** Default max FPS cap applied to renderer output. */
export const DEFAULT_MAX_FPS = 30;

/** Minimal slice of {@link VideoDeviceHandle} the writer actually consumes. */
export interface DeviceWriterSink {
  /** Write a chunk of frame bytes. */
  write(chunk: Uint8Array): boolean;
}

export interface AttachDeviceWriterOptions {
  /** Renderer whose frames are forwarded to the sink. */
  renderer: AvatarRenderer;
  /** The open v4l2 device handle's write target. */
  sink: DeviceWriterSink;
  /**
   * Maximum frames-per-second forwarded to the sink. Frames arriving
   * inside the cap's interval are dropped. Defaults to
   * {@link DEFAULT_MAX_FPS}. Pass `Infinity` to disable rate limiting.
   */
  maxFps?: number;
  /**
   * Monotonic clock source. Defaults to `Date.now`. Tests inject a
   * synthetic clock so FPS-cap behaviour can be asserted without
   * wall-clock sleeps.
   */
  now?: () => number;
  /**
   * Optional observer fired for every frame received from the renderer
   * — _before_ the FPS gate. Used by tests to count inputs. Receives
   * the dispatch decision so tests can assert on drop counts.
   */
  onFrameProcessed?: (frame: Y4MFrame, dispatched: boolean) => void;
}

/** Handle returned from {@link attachDeviceWriter}. Call `stop()` to detach. */
export interface DeviceWriterHandle {
  /** Unsubscribe from the renderer and stop forwarding frames. Idempotent. */
  stop(): void;
  /** How many frames have been forwarded to the sink. Diagnostic. */
  dispatchedCount(): number;
  /** How many frames were dropped by the FPS cap. Diagnostic. */
  droppedCount(): number;
}

/**
 * Compute the minimum milliseconds that must elapse between two
 * dispatches at the given FPS cap. `Infinity` disables the cap entirely
 * (every frame goes through).
 */
function minIntervalMs(maxFps: number): number {
  if (!Number.isFinite(maxFps) || maxFps <= 0) return 0;
  return Math.floor(1000 / maxFps);
}

/**
 * Attach a device writer that forwards the renderer's frames to the
 * sink, applying an FPS cap. Returns a handle whose `stop()` unhooks
 * the subscription — the handle's `dispatchedCount` /
 * `droppedCount` accessors are diagnostic (useful in tests and in
 * future `/avatar/status` endpoints).
 */
export function attachDeviceWriter(
  options: AttachDeviceWriterOptions,
): DeviceWriterHandle {
  const {
    renderer,
    sink,
    maxFps = DEFAULT_MAX_FPS,
    now = Date.now,
    onFrameProcessed,
  } = options;

  const interval = minIntervalMs(maxFps);
  let lastDispatchedAt = Number.NEGATIVE_INFINITY;
  let dispatched = 0;
  let dropped = 0;
  let stopped = false;

  const unsubscribe = renderer.onFrame((frame) => {
    if (stopped) return;

    // FPS cap: drop if the previous dispatch is too recent.
    const ts = now();
    let allowDispatch: boolean;
    if (interval <= 0) {
      allowDispatch = true;
    } else {
      allowDispatch = ts - lastDispatchedAt >= interval;
    }

    if (!allowDispatch) {
      dropped += 1;
      onFrameProcessed?.(frame, false);
      return;
    }

    lastDispatchedAt = ts;
    try {
      sink.write(frame.bytes);
      dispatched += 1;
      onFrameProcessed?.(frame, true);
    } catch {
      // Sink errors are best-effort — a failed write usually means the
      // kernel buffer hit back-pressure or the device handle was torn
      // down out from under us. Count it as a drop so the diagnostic
      // counters stay consistent.
      dropped += 1;
      onFrameProcessed?.(frame, false);
    }
  });

  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      try {
        unsubscribe();
      } catch {
        // Best-effort — the renderer's unsubscribe should be idempotent
        // but we don't want a buggy backend to crash the teardown path.
      }
    },
    dispatchedCount(): number {
      return dispatched;
    },
    droppedCount(): number {
      return dropped;
    },
  };
}
