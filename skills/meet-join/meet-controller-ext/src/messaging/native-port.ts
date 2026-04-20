/**
 * Thin wrapper around `chrome.runtime.connectNative("com.vellum.meet")` that
 *
 *   - validates every inbound frame as {@link BotToExtensionMessage} and every
 *     outbound frame as {@link ExtensionToBotMessage};
 *   - surfaces protocol-level errors via `onDisconnect(reason)` and attempts
 *     auto-reconnect with exponential backoff;
 *   - throws synchronously on malformed outbound messages so bugs in the
 *     extension surface at the call site rather than as silent drops on the
 *     native side.
 *
 * Backoff strategy: start at `reconnectBaseMs`, double after each disconnect
 * (capped at `reconnectMaxMs`), and reset back to `reconnectBaseMs` on the
 * first successful inbound message.
 */
import {
  BotToExtensionMessageSchema,
  ExtensionToBotMessageSchema,
  type BotToExtensionMessage,
  type ExtensionToBotMessage,
} from "../../../contracts/native-messaging.js";

/** Name of the native-messaging host the extension connects to. */
export const NATIVE_HOST_NAME = "com.vellum.meet";

/** Default starting backoff between reconnect attempts. */
export const DEFAULT_RECONNECT_BASE_MS = 500;

/** Default maximum backoff between reconnect attempts. */
export const DEFAULT_RECONNECT_MAX_MS = 5_000;

/** Options accepted by {@link openNativePort}. */
export interface OpenNativePortOptions {
  /** Starting backoff (milliseconds) after a disconnect. Defaults to 500ms. */
  reconnectBaseMs?: number;
  /** Maximum backoff (milliseconds) after repeated disconnects. Defaults to 5000ms. */
  reconnectMaxMs?: number;
}

/** Handle returned by {@link openNativePort}. */
export interface NativePort {
  /** Send a validated message to the native host. Throws if `msg` is invalid. */
  post(msg: ExtensionToBotMessage): void;
  /** Register a callback for every validated inbound {@link BotToExtensionMessage}. */
  onMessage(cb: (msg: BotToExtensionMessage) => void): void;
  /**
   * Register a callback fired after every successful `connectNative` call,
   * including reconnects. Use this to (re-)send any handshake the native host
   * expects on a fresh connection.
   */
  onConnect(cb: () => void): void;
  /**
   * Register a callback fired whenever the underlying port disconnects, whether
   * via transport failure, protocol error, or explicit {@link NativePort.close}.
   */
  onDisconnect(cb: (reason: string) => void): void;
  /** Close the port without attempting reconnect. Idempotent. */
  close(): void;
}

/**
 * Open a native-messaging port to {@link NATIVE_HOST_NAME} with inbound /
 * outbound Zod validation and exponential-backoff reconnect.
 */
export function openNativePort(opts: OpenNativePortOptions = {}): NativePort {
  const baseMs = opts.reconnectBaseMs ?? DEFAULT_RECONNECT_BASE_MS;
  const maxMs = opts.reconnectMaxMs ?? DEFAULT_RECONNECT_MAX_MS;

  const messageCallbacks: Array<(msg: BotToExtensionMessage) => void> = [];
  const connectCallbacks: Array<() => void> = [];
  const disconnectCallbacks: Array<(reason: string) => void> = [];

  let closed = false;
  let currentPort: chrome.runtime.Port | null = null;
  let currentBackoff = baseMs;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  function emitDisconnect(reason: string): void {
    for (const cb of disconnectCallbacks) {
      try {
        cb(reason);
      } catch (err) {
        console.warn("[meet-ext] onDisconnect callback threw", err);
      }
    }
  }

  function scheduleReconnect(): void {
    if (closed) return;
    if (reconnectTimer !== null) return;
    const delay = currentBackoff;
    currentBackoff = Math.min(currentBackoff * 2, maxMs);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (closed) return;
      connect();
    }, delay);
  }

  function connect(): void {
    if (closed) return;
    let port: chrome.runtime.Port;
    try {
      port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      emitDisconnect(`connectNative failed: ${reason}`);
      scheduleReconnect();
      return;
    }
    currentPort = port;

    port.onMessage.addListener((raw: unknown) => {
      const result = BotToExtensionMessageSchema.safeParse(raw);
      if (!result.success) {
        const reason = `protocol error: ${result.error.message}`;
        // Drop this frame, tear down the port, and attempt reconnect. The
        // native host is misbehaving; reopening the pipe is the safest
        // response since we have no channel to negotiate recovery.
        try {
          port.disconnect();
        } catch {
          // Already gone; ignore.
        }
        currentPort = null;
        emitDisconnect(reason);
        scheduleReconnect();
        return;
      }
      // Successful receipt — reset backoff to base.
      currentBackoff = baseMs;
      for (const cb of messageCallbacks) {
        try {
          cb(result.data);
        } catch (err) {
          console.warn("[meet-ext] onMessage callback threw", err);
        }
      }
    });

    port.onDisconnect.addListener(() => {
      currentPort = null;
      const lastError = chrome.runtime.lastError;
      const reason = lastError?.message ?? "native port disconnected";
      emitDisconnect(reason);
      scheduleReconnect();
    });

    // Notify listeners after the port is fully wired. This is the confirmed
    // "connection is usable" signal that callers use to post handshake
    // frames — posting synchronously at module scope risks racing with a
    // transient connectNative failure and killing the service worker.
    for (const cb of connectCallbacks) {
      try {
        cb();
      } catch (err) {
        console.warn("[meet-ext] onConnect callback threw", err);
      }
    }
  }

  connect();

  return {
    post(msg: ExtensionToBotMessage): void {
      // Validate synchronously so programmer errors throw at the call site.
      const parsed = ExtensionToBotMessageSchema.parse(msg);
      if (!currentPort) {
        throw new Error("native port not connected");
      }
      currentPort.postMessage(parsed);
    },
    onMessage(cb: (msg: BotToExtensionMessage) => void): void {
      messageCallbacks.push(cb);
    },
    onConnect(cb: () => void): void {
      connectCallbacks.push(cb);
      // If we're already connected by the time the caller subscribes, fire
      // immediately so the handshake still goes out.
      if (currentPort !== null) {
        try {
          cb();
        } catch (err) {
          console.warn("[meet-ext] onConnect callback threw", err);
        }
      }
    },
    onDisconnect(cb: (reason: string) => void): void {
      disconnectCallbacks.push(cb);
    },
    close(): void {
      if (closed) return;
      closed = true;
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (currentPort) {
        try {
          currentPort.disconnect();
        } catch {
          // Already gone; ignore.
        }
        currentPort = null;
      }
    },
  };
}
