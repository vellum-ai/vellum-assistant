/**
 * Relay WebSocket connection helper.
 *
 * Extracted from worker.ts so we can share the open/close/reconnect
 * lifecycle between the two relay transports:
 *
 *   - `self-hosted` — ws://127.0.0.1:<port>/v1/browser-relay, token minted
 *     by the local daemon (legacy path; default for back-compat).
 *   - `cloud`       — wss://<cloud-gateway>/v1/browser-relay, token from
 *     the cloud OAuth flow (see cloud-auth.ts).
 *
 * The class only knows how to open the socket, forward incoming messages
 * to the caller, and reconnect after unexpected closes. It does NOT parse
 * relay messages — worker.ts owns the envelope dispatch (ExtensionCommand
 * + host_browser_request via the PR 9 dispatcher) via the `onMessage`
 * callback.
 */

/** Reconnect backoff bounds mirror the legacy inline worker.ts values. */
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

/** WebSocket close codes that represent intentional, non-error closures. */
const NORMAL_CLOSE_CODES = new Set([1000, 1001]);

/**
 * Connection mode with the corresponding base URL + bearer token. The
 * base URL is normalised by {@link RelayConnection.buildUrl}: any
 * `http(s)://` scheme is rewritten to `ws(s)://` and a trailing slash is
 * stripped. Pass the daemon's HTTP origin for self-hosted mode and the
 * cloud gateway's HTTPS origin for cloud mode — the class figures out
 * the WebSocket scheme.
 */
export type RelayMode =
  | { kind: 'self-hosted'; baseUrl: string; token: string | null }
  | { kind: 'cloud'; baseUrl: string; token: string | null };

export interface RelayConnectionDeps {
  /**
   * Mode + token. The token is pre-fetched by the caller (so the caller
   * can decide whether to skip the connection entirely when there's no
   * token yet, e.g. before cloud sign-in or before self-hosted pairing).
   */
  mode: RelayMode;
  /** Invoked with the raw string payload for every incoming message. */
  onMessage: (data: string) => void;
  /** Invoked when the socket transitions to OPEN. */
  onOpen: () => void;
  /** Invoked when the socket closes (user-initiated or unexpected). */
  onClose: (code: number, reason: string) => void;
  /**
   * Optional: invoked right before a reconnect attempt is scheduled for
   * an unexpected close. Callers use this to refresh stale tokens before
   * the next `start()` attempt. If this returns a string, the new token
   * replaces `mode.token` for the next URL build.
   */
  onReconnect?: () => Promise<string | null | void>;
}

/**
 * Long-lived WebSocket helper. One instance per live relay session —
 * switching modes closes the current socket and constructs a new one.
 */
export class RelayConnection {
  private ws: WebSocket | null = null;
  private deps: RelayConnectionDeps;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = RECONNECT_BASE_MS;
  private closedByCaller = false;

  constructor(deps: RelayConnectionDeps) {
    this.deps = deps;
  }

  /** Current connection mode (read-only; use `setMode` to switch). */
  get mode(): RelayMode {
    return this.deps.mode;
  }

  /** Is the underlying socket currently in the OPEN readyState? */
  isOpen(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  /** Begin (or resume) connecting. Idempotent while already connected. */
  start(): void {
    this.closedByCaller = false;
    this.reconnectDelay = RECONNECT_BASE_MS;
    this.connect();
  }

  /**
   * Swap the connection mode / token without destroying the class
   * instance. The current socket is closed cleanly and a fresh one is
   * opened for the new mode. Used by the popup's mode switcher.
   */
  setMode(mode: RelayMode): void {
    this.deps = { ...this.deps, mode };
    // Tear down the current socket without marking the caller as having
    // closed us permanently — `start()` below re-arms shouldConnect.
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close(1000, 'mode switched');
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
    this.start();
  }

  /**
   * Send a raw string payload. No-op if the socket is not currently OPEN
   * — matches the existing worker.ts semantics where heartbeats and
   * responses silently drop when the socket is mid-reconnect.
   */
  send(data: string): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(data);
    }
  }

  /**
   * Close the socket permanently. After this the connection will not
   * reconnect on its own; call `start()` again to resume.
   */
  close(code = 1000, reason = 'closed by caller'): void {
    this.closedByCaller = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close(code, reason);
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
  }

  // ── Internals ─────────────────────────────────────────────────────

  private connect(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    const url = this.buildUrl();
    // Capture a local reference to the socket so that every listener
    // can verify it is still the active one before mutating shared
    // state. Without this, a `setMode()` that closes socket A and
    // immediately opens socket B can get A's asynchronous close event
    // delivered afterward — that stale event would otherwise clear the
    // reference to B and schedule a spurious reconnect.
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.addEventListener('open', () => {
      if (this.ws !== ws) return; // stale event from a superseded socket
      this.reconnectDelay = RECONNECT_BASE_MS;
      this.deps.onOpen();
    });

    ws.addEventListener('message', (event: MessageEvent) => {
      if (this.ws !== ws) return; // stale event from a superseded socket
      this.deps.onMessage(String(event.data));
    });

    ws.addEventListener('close', (event: CloseEvent) => {
      if (this.ws !== ws) return; // stale event from a superseded socket
      const code = event.code;
      const reason = event.reason;
      this.ws = null;
      this.deps.onClose(code, reason);
      if (!this.closedByCaller) {
        if (!NORMAL_CLOSE_CODES.has(code)) {
          this.scheduleReconnectWithRefresh();
        } else {
          this.scheduleReconnect();
        }
      }
    });

    ws.addEventListener('error', () => {
      if (this.ws !== ws) return; // stale event from a superseded socket
      // A close event will follow — nothing to do here beyond letting
      // the socket transition into CLOSING/CLOSED so we can reconnect.
    });
  }

  /** Build the WebSocket URL from the current mode. */
  private buildUrl(): string {
    const { mode } = this.deps;
    const base = mode.baseUrl.replace(/\/$/, '');
    const wsBase = base.replace(/^http/, 'ws');
    const url = `${wsBase}/v1/browser-relay`;
    if (mode.token) {
      return `${url}?token=${encodeURIComponent(mode.token)}`;
    }
    return url;
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return;
    const delay = this.reconnectDelay;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.closedByCaller) this.connect();
    }, delay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
  }

  /**
   * Unexpected close path: give the caller a chance to refresh the
   * token (e.g. the self-hosted daemon rotated its edge JWT, or the
   * cloud OAuth flow expired) before the next connect attempt.
   */
  private scheduleReconnectWithRefresh(): void {
    if (this.reconnectTimer !== null) return;
    const delay = this.reconnectDelay;
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (this.closedByCaller) return;
      if (this.deps.onReconnect) {
        try {
          const newToken = await this.deps.onReconnect();
          if (typeof newToken === 'string') {
            this.deps = {
              ...this.deps,
              mode: { ...this.deps.mode, token: newToken },
            };
          }
        } catch {
          // Refresh failures fall through to a bare reconnect attempt —
          // the server will reject the handshake and we'll loop.
        }
      }
      if (!this.closedByCaller) this.connect();
    }, delay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
  }
}
