/**
 * Raw CDP JSON-RPC WebSocket transport used by the `cdp-inspect`
 * backend. This module is intentionally backend-agnostic: it has no
 * dependency on the browser-session manager, the cdp-inspect client,
 * or any feature-flag / config plumbing. It simply adapts a CDP
 * WebSocket URL (as returned from DevTools `/json/version` or
 * `/json/list`) into an asynchronous request/response + event
 * interface.
 *
 * The transport is deliberately minimal:
 *   - `send(method, params, opts?)` writes a JSON-RPC 2.0 request
 *     frame with a monotonic id, registers a pending entry in the
 *     correlation map, and resolves/rejects when the matching
 *     response arrives (or the socket dies / the caller aborts).
 *   - `addEventListener(listener)` subscribes to every inbound frame
 *     that carries no `id` — these are CDP domain events fanned out
 *     verbatim to listeners. Listeners do not affect request/response
 *     correlation.
 *   - `dispose()` proactively closes the socket and rejects every
 *     still-pending request exactly once with `CdpWsTransportError(
 *     "closed")`. It is idempotent.
 *
 * Failure modes map 1:1 onto {@link CdpWsTransportError} codes:
 *   - `closed`         — the socket was closed (remote close,
 *                        `dispose()`, or a pending send racing an
 *                        already-closed transport).
 *   - `aborted`        — the per-request `AbortSignal` fired. Any
 *                        subsequent CDP response for that id is
 *                        silently dropped.
 *   - `timeout`        — the connect timeout expired before the
 *                        socket reached `OPEN`.
 *   - `transport_error`— a WebSocket `error` event fired, or a send
 *                        failed (e.g. serialization failure).
 *   - `cdp_error`      — the peer returned a JSON-RPC error envelope
 *                        (`{id, error: {code, message}}`).
 */

export type CdpWsTransportErrorCode =
  | "closed"
  | "aborted"
  | "timeout"
  | "transport_error"
  | "cdp_error";

/**
 * Error thrown (or used to reject) by {@link CdpWsTransport} and
 * {@link connectCdpWsTransport}. The `code` discriminates the
 * category of failure so callers can branch without string-sniffing
 * the message. For `cdp_error`, the CDP JSON-RPC error envelope
 * fields are copied through verbatim for logging and upstream
 * error mapping.
 */
export class CdpWsTransportError extends Error {
  readonly code: CdpWsTransportErrorCode;
  readonly cdpMethod?: string;
  readonly cdpCode?: number;
  readonly cdpMessage?: string;
  readonly cdpData?: unknown;
  readonly underlying?: unknown;

  constructor(
    code: CdpWsTransportErrorCode,
    message?: string,
    details?: {
      cdpMethod?: string;
      cdpCode?: number;
      cdpMessage?: string;
      cdpData?: unknown;
      underlying?: unknown;
    },
  ) {
    super(message ?? code);
    this.name = "CdpWsTransportError";
    this.code = code;
    this.cdpMethod = details?.cdpMethod;
    this.cdpCode = details?.cdpCode;
    this.cdpMessage = details?.cdpMessage;
    this.cdpData = details?.cdpData;
    this.underlying = details?.underlying;
  }
}

/**
 * Payload handed to event listeners registered via
 * {@link CdpWsTransport.addEventListener}. Mirrors the wire-level
 * shape of a CDP JSON-RPC notification minus the `id` field
 * (notifications, by definition, carry no id).
 */
export interface CdpTransportEvent {
  method: string;
  params?: unknown;
  sessionId?: string;
}

/**
 * Public interface exposed by this transport. Deliberately narrower
 * than the higher-level `CdpClient` type used by tool code — this
 * layer does not know about conversations, backend selection, or
 * CDP error mapping to the shared `CdpError` taxonomy.
 */
export interface CdpWsTransport {
  /**
   * Send a CDP method call over the socket and await its response.
   *
   * - `method` / `params` are serialized verbatim into a JSON-RPC
   *   2.0 request envelope.
   * - `opts.sessionId`, if provided, is forwarded on the wire as a
   *   top-level `sessionId` field — required for CDP "flattened"
   *   session attach mode.
   * - `opts.signal` cancels the pending request: the returned
   *   promise rejects with `CdpWsTransportError("aborted")` and any
   *   subsequent response carrying the matching id is dropped.
   *
   * Failure modes:
   *   - resolves with the `result` field on success.
   *   - rejects with `cdp_error` if the peer returns a
   *     `{id, error}` envelope.
   *   - rejects with `closed` if the socket closes (or is disposed)
   *     before a response arrives.
   *   - rejects with `aborted` if the caller cancels.
   *   - rejects with `transport_error` if the send itself fails
   *     (e.g. the socket is already in a non-OPEN state and we race
   *     a close, or JSON serialization fails).
   */
  send<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    opts?: { sessionId?: string; signal?: AbortSignal },
  ): Promise<T>;

  /**
   * Register a listener for every inbound JSON-RPC notification
   * (i.e. any frame whose `id` is missing). Returns an unsubscribe
   * function. Listener errors are swallowed so one bad consumer
   * cannot tear down the transport.
   */
  addEventListener(listener: (event: CdpTransportEvent) => void): () => void;

  /**
   * Close the underlying socket and reject every still-pending
   * request with `CdpWsTransportError("closed")`. Idempotent —
   * calling `dispose()` twice does nothing on the second call. A
   * `dispose()` after a remote close is still safe.
   */
  dispose(): void;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: CdpWsTransportError) => void;
  method: string;
  // Listener cleanup for the per-request abort signal. May be null if
  // the caller did not provide a signal.
  cleanupAbort: (() => void) | null;
}

/**
 * Minimal structural shape of the WebSocket we depend on. Using a
 * local interface (instead of the DOM / bun-types `WebSocket`
 * global's static constants) lets us stay compatible with either
 * runtime and keeps the tests free of DOM typing hassles.
 */
interface WsLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "close", listener: () => void): void;
  addEventListener(type: "error", listener: (ev: unknown) => void): void;
  addEventListener(
    type: "message",
    listener: (ev: { data: unknown }) => void,
  ): void;
  removeEventListener?: (type: string, listener: unknown) => void;
}

// WebSocket.readyState constants. We avoid depending on the global
// WebSocket static (e.g. `WebSocket.OPEN`) because test fakes may not
// expose the static properties.
const WS_OPEN = 1;

const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;

/**
 * Open a raw CDP WebSocket transport against `url`. Resolves only
 * after the socket has reached `OPEN`; rejects with
 * `CdpWsTransportError("timeout")` if the connect-timeout expires,
 * `CdpWsTransportError("aborted")` if `opts.signal` fires, or
 * `transport_error` if the socket errors or closes before opening.
 */
export async function connectCdpWsTransport(
  url: string,
  opts?: { connectTimeoutMs?: number; signal?: AbortSignal },
): Promise<CdpWsTransport> {
  const connectTimeoutMs = opts?.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const callerSignal = opts?.signal;

  if (callerSignal?.aborted) {
    throw new CdpWsTransportError("aborted", "aborted before connect");
  }

  // bun's global `WebSocket` is API-compatible with the browser one.
  const WebSocketCtor: new (url: string) => WsLike = (
    globalThis as unknown as {
      WebSocket: new (url: string) => WsLike;
    }
  ).WebSocket;
  if (typeof WebSocketCtor !== "function") {
    throw new CdpWsTransportError(
      "transport_error",
      "global WebSocket is not available in this runtime",
    );
  }

  let ws: WsLike;
  try {
    ws = new WebSocketCtor(url);
  } catch (err) {
    throw new CdpWsTransportError(
      "transport_error",
      err instanceof Error ? err.message : String(err),
      { underlying: err },
    );
  }

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanupAbort();
      try {
        ws.close();
      } catch {
        // best effort
      }
      reject(new CdpWsTransportError("timeout", "connect timeout"));
    }, connectTimeoutMs);

    const onOpen = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanupAbort();
      resolve();
    };
    const onError = (ev: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanupAbort();
      try {
        ws.close();
      } catch {
        // best effort
      }
      reject(
        new CdpWsTransportError(
          "transport_error",
          "websocket error during connect",
          { underlying: ev },
        ),
      );
    };
    const onCloseBeforeOpen = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanupAbort();
      reject(
        new CdpWsTransportError(
          "transport_error",
          "websocket closed before open",
        ),
      );
    };
    const onCallerAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanupAbort();
      try {
        ws.close();
      } catch {
        // best effort
      }
      reject(new CdpWsTransportError("aborted", "aborted during connect"));
    };
    const cleanupAbort = () => {
      if (callerSignal) {
        callerSignal.removeEventListener("abort", onCallerAbort);
      }
    };

    ws.addEventListener("open", onOpen);
    ws.addEventListener("error", onError);
    ws.addEventListener("close", onCloseBeforeOpen);
    if (callerSignal) {
      callerSignal.addEventListener("abort", onCallerAbort, { once: true });
    }
  });

  return createTransport(ws);
}

function createTransport(ws: WsLike): CdpWsTransport {
  const pending = new Map<number, PendingRequest>();
  const listeners = new Set<(event: CdpTransportEvent) => void>();
  let nextId = 1;
  let disposed = false;
  let closed = false;

  const rejectAllPending = (code: CdpWsTransportErrorCode, message: string) => {
    if (pending.size === 0) return;
    // Snapshot entries so that caller `.catch()` handlers invoked
    // synchronously via `reject` cannot mutate the map we are iterating.
    const entries = Array.from(pending.entries());
    pending.clear();
    for (const [, entry] of entries) {
      entry.cleanupAbort?.();
      entry.reject(
        new CdpWsTransportError(code, message, { cdpMethod: entry.method }),
      );
    }
  };

  const handleMessage = (ev: { data: unknown }) => {
    if (disposed) return;
    let raw: string;
    if (typeof ev.data === "string") {
      raw = ev.data;
    } else if (ev.data instanceof ArrayBuffer) {
      raw = new TextDecoder().decode(ev.data);
    } else if (
      typeof (ev.data as { toString?: () => string })?.toString === "function"
    ) {
      raw = String(ev.data);
    } else {
      // Unknown binary payload — CDP is always JSON text, so drop it.
      return;
    }
    let frame: unknown;
    try {
      frame = JSON.parse(raw);
    } catch {
      return;
    }
    if (!frame || typeof frame !== "object") return;
    const obj = frame as {
      id?: unknown;
      result?: unknown;
      error?: { code?: unknown; message?: unknown; data?: unknown };
      method?: unknown;
      params?: unknown;
      sessionId?: unknown;
    };

    if (typeof obj.id === "number") {
      const entry = pending.get(obj.id);
      if (!entry) {
        // Either an unknown id (protocol violation) or an aborted
        // request whose entry we already removed — drop silently.
        return;
      }
      pending.delete(obj.id);
      entry.cleanupAbort?.();
      if (obj.error && typeof obj.error === "object") {
        const cdpCode =
          typeof obj.error.code === "number" ? obj.error.code : undefined;
        const cdpMessage =
          typeof obj.error.message === "string" ? obj.error.message : undefined;
        entry.reject(
          new CdpWsTransportError(
            "cdp_error",
            cdpMessage ?? `cdp error for ${entry.method}`,
            {
              cdpMethod: entry.method,
              cdpCode,
              cdpMessage,
              cdpData: obj.error.data,
            },
          ),
        );
      } else {
        entry.resolve(obj.result);
      }
      return;
    }

    // No id → CDP domain event. Fan out to listeners, swallowing
    // any listener throws.
    if (typeof obj.method === "string") {
      const event: CdpTransportEvent = {
        method: obj.method,
        params: obj.params,
        sessionId:
          typeof obj.sessionId === "string" ? obj.sessionId : undefined,
      };
      for (const listener of listeners) {
        try {
          listener(event);
        } catch {
          // listener errors are swallowed to keep the transport alive
        }
      }
    }
  };

  const handleClose = () => {
    if (closed) return;
    closed = true;
    rejectAllPending("closed", "websocket closed");
  };

  const handleError = (ev: unknown) => {
    if (closed) return;
    closed = true;
    // Best-effort close after an error so we don't leak a half-open
    // socket. Do not throw on already-closed sockets.
    try {
      ws.close();
    } catch {
      // ignored
    }
    // Reject pending as transport_error so callers can distinguish
    // a protocol-level peer close from an explicit socket error.
    if (pending.size > 0) {
      const entries = Array.from(pending.entries());
      pending.clear();
      for (const [, entry] of entries) {
        entry.cleanupAbort?.();
        entry.reject(
          new CdpWsTransportError("transport_error", "websocket error", {
            cdpMethod: entry.method,
            underlying: ev,
          }),
        );
      }
    }
  };

  ws.addEventListener("message", handleMessage);
  ws.addEventListener("close", handleClose);
  ws.addEventListener("error", handleError);

  const transport: CdpWsTransport = {
    send<T = unknown>(
      method: string,
      params?: Record<string, unknown>,
      opts?: { sessionId?: string; signal?: AbortSignal },
    ): Promise<T> {
      if (disposed || closed) {
        return Promise.reject(
          new CdpWsTransportError("closed", "transport already closed", {
            cdpMethod: method,
          }),
        );
      }
      const signal = opts?.signal;
      if (signal?.aborted) {
        return Promise.reject(
          new CdpWsTransportError("aborted", "aborted before send", {
            cdpMethod: method,
          }),
        );
      }

      const id = nextId++;
      const frame: Record<string, unknown> = { id, method };
      if (params !== undefined) frame.params = params;
      if (opts?.sessionId !== undefined) frame.sessionId = opts.sessionId;

      let serialized: string;
      try {
        serialized = JSON.stringify(frame);
      } catch (err) {
        return Promise.reject(
          new CdpWsTransportError(
            "transport_error",
            err instanceof Error ? err.message : String(err),
            { cdpMethod: method, underlying: err },
          ),
        );
      }

      // Guard against sending on a non-OPEN socket. By construction
      // the socket is OPEN at the time we hand the transport to
      // callers (connectCdpWsTransport waits for the `open` event),
      // so any other readyState means the socket has since moved
      // past OPEN — treat it as closed so callers can't observe
      // silently dropped frames.
      if (ws.readyState !== WS_OPEN) {
        return Promise.reject(
          new CdpWsTransportError("closed", "socket not open", {
            cdpMethod: method,
          }),
        );
      }

      return new Promise<T>((resolve, reject) => {
        // Register the pending entry FIRST so that an abort or
        // inbound response racing the rest of this function body
        // always has a live entry to act on. Without this ordering
        // a synchronous abort registered below could fire before
        // the entry exists, silently dropping the cancellation.
        pending.set(id, {
          resolve: (value: unknown) => resolve(value as T),
          reject,
          method,
          cleanupAbort: null,
        });

        if (signal) {
          const onAbort = () => {
            const entry = pending.get(id);
            if (!entry) return;
            pending.delete(id);
            entry.cleanupAbort?.();
            entry.reject(
              new CdpWsTransportError("aborted", "aborted during send", {
                cdpMethod: method,
              }),
            );
          };
          signal.addEventListener("abort", onAbort, { once: true });
          const entry = pending.get(id);
          if (entry) {
            entry.cleanupAbort = () => {
              signal.removeEventListener("abort", onAbort);
            };
          }
        }

        try {
          ws.send(serialized);
        } catch (err) {
          const entry = pending.get(id);
          if (entry) {
            pending.delete(id);
            entry.cleanupAbort?.();
          }
          reject(
            new CdpWsTransportError(
              "transport_error",
              err instanceof Error ? err.message : String(err),
              { cdpMethod: method, underlying: err },
            ),
          );
        }
      });
    },

    addEventListener(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      // Reject pending requests BEFORE calling close() so that
      // callers observe the explicit "disposed" signal even if the
      // underlying `close()` fires a synchronous `close` event.
      rejectAllPending("closed", "transport disposed");
      if (!closed) {
        closed = true;
        try {
          ws.close();
        } catch {
          // ignored — already-closed sockets may throw
        }
      }
    },
  };

  return transport;
}
