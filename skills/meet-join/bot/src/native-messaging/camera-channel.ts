/**
 * Bot-side helpers for the camera.enable / camera.disable native-messaging
 * round-trip. Dispatches a `camera.enable` / `camera.disable` command to
 * the extension over the shared NMH socket and awaits the matching
 * `camera_result` frame correlated by `requestId`.
 *
 * Mirrors the shape of the `/send_chat` path in `main.ts` — both use the
 * same `pendingRequests` pattern and the same request-id correlation.
 * Extracted into its own module (rather than inlined in `main.ts`) so the
 * HTTP server's `/avatar/enable` and `/avatar/disable` routes can call
 * into a small, testable surface that only knows how to toggle the
 * camera, without taking a dependency on the broader bot wiring.
 *
 * Timeout: the extension's camera feature polls aria-state for up to 5s
 * before giving up, so the bot's bound is set to 7s — the extension-side
 * poll plus a small buffer for native-messaging round-trip latency. A
 * timeout here means the extension never replied at all (crashed, or the
 * socket disconnected mid-toggle), which is distinct from the extension
 * replying `ok: false` (which surfaces as a rejected promise with the
 * extension's own error message).
 */

import type {
  BotToExtensionMessage,
  ExtensionToBotMessage,
} from "../../../contracts/native-messaging.js";

/**
 * Default timeout for a camera-toggle round-trip. Sized to allow the
 * extension's 5s aria-state confirmation window plus a small buffer for
 * native-messaging latency. Override in tests via the `timeoutMs` option.
 */
export const DEFAULT_CAMERA_CHANNEL_TIMEOUT_MS = 7_000;

/** Options common to {@link enableCamera} and {@link disableCamera}. */
export interface CameraChannelOptions {
  /**
   * Dispatch a command to the extension. Thin wrapper over
   * `NmhSocketServer.sendToExtension` so the channel can be unit-tested
   * without standing up a real socket.
   */
  sendToExtension: (msg: BotToExtensionMessage) => void;
  /**
   * Factory for a listener-registration hook. Returns the
   * `socketServer.onExtensionMessage` shape; the channel registers its
   * listener at construction time (via {@link createCameraChannel}).
   */
  onExtensionMessage: (cb: (msg: ExtensionToBotMessage) => void) => void;
  /** Correlation-id factory. Defaults to `crypto.randomUUID()`. */
  generateRequestId?: () => string;
  /** Per-call timeout. Defaults to {@link DEFAULT_CAMERA_CHANNEL_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/**
 * Result of a camera-toggle round-trip. `changed` distinguishes a real
 * state transition from a no-op short-circuit (toggle was already in the
 * requested state).
 */
export interface CameraChannelResult {
  changed: boolean;
}

/**
 * Narrow surface the camera channel exposes to the rest of the bot. The
 * HTTP server's `/avatar/enable` / `/avatar/disable` routes call these
 * directly; each method returns the extension's confirmation that the
 * toggle reached the requested state (or rejects with a descriptive error).
 */
export interface CameraChannel {
  enableCamera(): Promise<CameraChannelResult>;
  disableCamera(): Promise<CameraChannelResult>;
  /**
   * Reject every in-flight request so callers awaiting
   * {@link enableCamera} / {@link disableCamera} unblock on shutdown
   * rather than hanging until their own timer fires.
   */
  shutdown(reason: string): void;
}

/**
 * Build a camera channel wired to the provided socket-server callbacks.
 * Registers a single listener for `camera_result` frames; subsequent
 * dispatches pipe through the same listener without re-registering.
 */
export function createCameraChannel(
  opts: CameraChannelOptions,
): CameraChannel {
  const { sendToExtension, onExtensionMessage } = opts;
  const generateRequestId =
    opts.generateRequestId ?? (() => crypto.randomUUID());
  const defaultTimeoutMs = opts.timeoutMs ?? DEFAULT_CAMERA_CHANNEL_TIMEOUT_MS;

  interface Pending {
    resolve: (result: CameraChannelResult) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }

  const pending = new Map<string, Pending>();

  // Register the listener exactly once at construction. The socket server
  // supports multiple listeners (fan-out), so adding one here is safe even
  // when other modules also subscribe for their own message types.
  onExtensionMessage((msg) => {
    if (msg.type !== "camera_result") return;
    const req = pending.get(msg.requestId);
    if (!req) {
      // Late reply for a request we already gave up on (timeout) or a
      // fabricated requestId. Drop silently — the bot's main logger
      // layer surfaces unknown-request-id noise for send_chat but we
      // keep this path quiet because the avatar enable/disable retry
      // loop can produce bursts of late replies during reconnect.
      return;
    }
    clearTimeout(req.timer);
    pending.delete(msg.requestId);
    if (msg.ok) {
      req.resolve({ changed: msg.changed ?? true });
      return;
    }
    req.reject(
      new Error(
        msg.error
          ? `camera toggle failed: ${msg.error}`
          : "camera toggle failed (extension did not provide a reason)",
      ),
    );
  });

  function roundTrip(
    type: "camera.enable" | "camera.disable",
  ): Promise<CameraChannelResult> {
    const requestId = generateRequestId();
    return new Promise<CameraChannelResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(
          new Error(
            `camera toggle (${type}): extension did not reply within ${defaultTimeoutMs}ms (requestId=${requestId})`,
          ),
        );
      }, defaultTimeoutMs);
      pending.set(requestId, { resolve, reject, timer });

      try {
        sendToExtension({ type, requestId });
      } catch (err) {
        clearTimeout(timer);
        pending.delete(requestId);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  return {
    enableCamera: () => roundTrip("camera.enable"),
    disableCamera: () => roundTrip("camera.disable"),
    shutdown(reason: string): void {
      for (const [requestId, req] of pending.entries()) {
        clearTimeout(req.timer);
        req.reject(
          new Error(`camera toggle aborted: ${reason} (requestId=${requestId})`),
        );
      }
      pending.clear();
    },
  };
}
