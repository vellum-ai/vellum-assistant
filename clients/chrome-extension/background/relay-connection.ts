/**
 * Relay WebSocket connection helper.
 *
 * Shares the open/close/reconnect lifecycle between the two relay
 * transports:
 *
 *   - `self-hosted` — ws://127.0.0.1:<port>/v1/browser-relay, token minted
 *     by the local daemon.
 *   - `cloud`       — wss://<cloud-gateway>/v1/browser-relay, token from
 *     the cloud OAuth flow (see cloud-auth.ts).
 *
 * The class only knows how to open the socket, forward incoming messages
 * to the caller, and reconnect after unexpected closes. It does NOT parse
 * relay messages — worker.ts owns the host_browser_request envelope
 * dispatch via the `onMessage` callback.
 *
 * This module also exports {@link postHostBrowserResult}, the relay-aware
 * helper used by the host-browser dispatcher to ship CDP result envelopes
 * back to the daemon. In self-hosted mode the result is POSTed to the
 * local `/v1/host-browser-result` HTTP endpoint; in cloud mode it
 * round-trips back through the gateway WebSocket — see the function
 * docstring for the full behaviour.
 */

import type {
  HostBrowserEventEnvelope,
  HostBrowserResultEnvelope,
  HostBrowserSessionInvalidatedEnvelope,
} from './host-browser-dispatcher.js';

/** Reconnect backoff bounds for transient relay disconnects. */
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

/**
 * Context passed to {@link RelayConnectionDeps.onReconnect}. Includes the
 * close code / reason so the handler can tell an authentication failure
 * (e.g. expired JWT closed with a 4001 policy code) apart from a
 * transient network blip — the cloud refresh path uses this to decide
 * whether to force a non-interactive OAuth renewal.
 */
export interface RelayReconnectContext {
  /** Close code from the unexpected WebSocket close. */
  code: number;
  /** Close reason string from the unexpected WebSocket close. */
  reason: string;
}

/**
 * Outcome of a reconnect refresh attempt.
 *
 * - `{ kind: 'refreshed', token }`: the stored token was successfully
 *   rotated — the relay helper rebuilds `mode.token` and schedules the
 *   next connect attempt.
 * - `{ kind: 'keep' }`: nothing to refresh; reuse the current token for
 *   the next connect attempt (e.g. a transient network drop where the
 *   existing token is still valid).
 * - `{ kind: 'abort', error }`: refresh is impossible and reconnects
 *   must stop. The relay helper marks itself closed and propagates the
 *   error to its `onClose` hook so the worker can surface an actionable
 *   UI error.
 */
export type RelayReconnectDecision =
  | { kind: 'refreshed'; token: string }
  | { kind: 'keep' }
  | { kind: 'abort'; error: string };

export interface RelayConnectionDeps {
  /**
   * Mode + token. The token is pre-fetched by the caller (so the caller
   * can decide whether to skip the connection entirely when there's no
   * token yet, e.g. before cloud sign-in or before self-hosted pairing).
   */
  mode: RelayMode;
  /**
   * Stable per-extension-install identifier, plumbed into the WebSocket
   * URL as a `clientInstanceId` query param on every handshake. The
   * runtime registry keys inner entries by this value so multiple
   * parallel installs for the same guardian (two Chrome profiles, two
   * desktops sharing a sync identity) don't evict each other on
   * register/unregister. Undefined is allowed for backwards
   * compatibility — the runtime synthesizes a connection-scoped
   * fallback in that case.
   */
  clientInstanceId?: string;
  /** Invoked with the raw string payload for every incoming message. */
  onMessage: (data: string) => void;
  /** Invoked when the socket transitions to OPEN. */
  onOpen: () => void;
  /**
   * Invoked when the socket closes (user-initiated or unexpected).
   * `authError` is populated when the reconnect path aborted because the
   * refresh hook returned `{ kind: 'abort' }` — callers should surface
   * the message verbatim to the user and leave the extension disconnected.
   */
  onClose: (code: number, reason: string, authError?: string) => void;
  /**
   * Optional: invoked right before a reconnect attempt is scheduled for
   * an unexpected close. Callers use this to refresh stale tokens before
   * the next `start()` attempt.
   *
   * Two return shapes are accepted:
   *
   *   - A plain `Promise<string | null | void>`, where:
   *     - `string` is treated as `{ kind: 'refreshed', token: <string> }`.
   *     - `null` / `undefined` is treated as `{ kind: 'keep' }`.
   *   - A {@link RelayReconnectDecision}, which additionally lets the
   *     hook abort the reconnect loop entirely when refresh is
   *     impossible (e.g. the cloud OAuth flow can no longer renew
   *     non-interactively and the user must sign in again).
   *
   * The {@link RelayReconnectContext} argument carries the close code
   * / reason so handlers can distinguish auth-failure closes from
   * transient network drops without stashing state in module-level
   * variables.
   */
  onReconnect?: (
    ctx: RelayReconnectContext,
  ) => Promise<string | null | void | RelayReconnectDecision>;
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
  /**
   * Context of a non-normal ws close whose onClose notification has
   * been deferred into the reconnect-with-refresh timer. Populated
   * from the ws 'close' listener BEFORE arming the timer, and cleared
   * right before the timer's setTimeout callback fires onClose (on
   * abort/keep/refreshed branches). When {@link close} is called
   * while this is non-null the caller is racing the deferred
   * notification — we fire the single pending onClose before
   * clearing the timer to keep the exactly-once invariant.
   *
   * Without this guard, `close()` would silently cancel the timer
   * and the caller would see ZERO onClose calls for the lifecycle,
   * turning the contract from "exactly once" into "at most once".
   */
  private pendingDeferredCloseCtx: RelayReconnectContext | null = null;

  constructor(deps: RelayConnectionDeps) {
    this.deps = deps;
  }

  /**
   * Return the live connection mode. Callers must invoke this right
   * before each use — after a reconnect-with-refresh cycle the
   * underlying `deps.mode` is replaced with a brand new object holding
   * the freshly minted token, and any caller that cached the result of
   * a previous invocation would still be using the stale token. In
   * particular, worker.ts's `dispatchHostBrowserResult` MUST pull the
   * mode through this accessor per-POST so that result envelopes sent
   * after a WebSocket drop authenticate with the new bearer token
   * instead of silently 401/403ing.
   *
   * This is the ONLY public accessor for the mode — there is
   * deliberately no `get mode()` getter, because a property-style
   * access reads as a static field and invites callers to cache it.
   */
  getCurrentMode(): RelayMode {
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
   *
   * A mode switch ends the previous lifecycle: any pending deferred
   * close notification left over from a non-normal ws close on the
   * old lifecycle is flushed synchronously before the new socket is
   * constructed, so the caller still sees exactly one onClose per
   * lifecycle and the stale ctx cannot cross into the new lifecycle
   * (where a later explicit `close()` would otherwise re-deliver it
   * with the wrong code/reason).
   */
  setMode(mode: RelayMode): void {
    this.deps = { ...this.deps, mode };
    // Flush any pending deferred close from the prior lifecycle first.
    // When the previous socket hit a non-normal close the ws listener
    // stashed its ctx into `pendingDeferredCloseCtx` and armed the
    // reconnect-with-refresh timer. Clearing the timer below without
    // firing the deferred notification would leave the caller with
    // zero onClose calls for the prior lifecycle, and any subsequent
    // `close()` on the new lifecycle would re-deliver the old ctx as
    // if it belonged to the new socket.
    if (this.pendingDeferredCloseCtx !== null) {
      const deferred = this.pendingDeferredCloseCtx;
      this.pendingDeferredCloseCtx = null;
      this.deps.onClose(deferred.code, deferred.reason);
    }
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
   *
   * If a non-normal ws close already fired and deferred its onClose
   * notification into a reconnect timer that hasn't executed yet,
   * fire that single pending notification before clearing the timer
   * so the caller still sees exactly one onClose per lifecycle. The
   * previous behaviour silently cancelled the timer and left the
   * caller with zero close callbacks for the aborted lifecycle,
   * which broke the invariant documented on
   * {@link scheduleReconnectWithRefresh}.
   */
  close(code = 1000, reason = 'closed by caller'): void {
    this.closedByCaller = true;
    if (this.pendingDeferredCloseCtx !== null) {
      const deferred = this.pendingDeferredCloseCtx;
      this.pendingDeferredCloseCtx = null;
      this.deps.onClose(deferred.code, deferred.reason);
    }
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
      if (this.closedByCaller) {
        // The caller tore down this connection (mode switch, explicit
        // close, etc.) — fire onClose exactly once and stop.
        this.deps.onClose(code, reason);
        return;
      }
      if (NORMAL_CLOSE_CODES.has(code)) {
        // Clean server-initiated close (e.g. 1000/1001). Notify the
        // caller and schedule a plain reconnect without going through
        // the refresh hook.
        this.deps.onClose(code, reason);
        this.scheduleReconnect();
        return;
      }
      // Non-normal close: defer the onClose notification until after
      // the reconnect-with-refresh decision resolves so the caller
      // sees exactly one onClose call per lifecycle. The helper
      // surfaces an authError when refresh returns/aborts.
      //
      // Track the pending deferred close so that a concurrent
      // close() call that clears the timer can still fire onClose
      // once before tearing down — otherwise the caller would see
      // zero close notifications for this lifecycle.
      const deferredCtx = { code, reason };
      this.pendingDeferredCloseCtx = deferredCtx;
      this.scheduleReconnectWithRefresh(deferredCtx);
    });

    ws.addEventListener('error', () => {
      if (this.ws !== ws) return; // stale event from a superseded socket
      // A close event will follow — nothing to do here beyond letting
      // the socket transition into CLOSING/CLOSED so we can reconnect.
    });
  }

  /** Build the WebSocket URL from the current mode. */
  private buildUrl(): string {
    const { mode, clientInstanceId } = this.deps;
    const base = mode.baseUrl.replace(/\/$/, '');
    const wsBase = base.replace(/^http/, 'ws');
    // Build the query string by hand rather than via URLSearchParams
    // so the token encoding stays pinned to encodeURIComponent
    // semantics (URLSearchParams normalizes ' ' → '+' instead of
    // '%20', which would flip existing handshake URLs downstream).
    const parts: string[] = [];
    if (mode.token) {
      parts.push(`token=${encodeURIComponent(mode.token)}`);
    }
    if (clientInstanceId) {
      parts.push(`clientInstanceId=${encodeURIComponent(clientInstanceId)}`);
    }
    return parts.length > 0
      ? `${wsBase}/v1/browser-relay?${parts.join('&')}`
      : `${wsBase}/v1/browser-relay`;
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
   *
   * The close `code` / `reason` are forwarded as a
   * {@link RelayReconnectContext} so the handler can tell an
   * auth-failure close (4001/4002/4003/1008, or 1006 when the
   * pre-upgrade HTTP 401 surfaces as abnormal closure) apart from a
   * transient network drop. For auth-failure closes in cloud mode the
   * handler returns `{ kind: 'abort' }` when refresh is impossible —
   * we stop the reconnect loop, mark the connection closed, and
   * surface the error through `onClose` so the popup UI can prompt
   * the user to sign in again instead of silently hammering the
   * gateway.
   *
   * `onClose` is invoked EXACTLY ONCE per lifecycle here: either with
   * `authError` set when the refresh hook aborts, or with `authError`
   * undefined when we proceed with a reconnect attempt. The
   * `ws.addEventListener('close', ...)` handler deliberately does NOT
   * fire onClose for non-normal closes — it defers that
   * responsibility to this method so the caller never sees a double
   * invocation on the abort-decision path.
   */
  private scheduleReconnectWithRefresh(ctx: RelayReconnectContext): void {
    if (this.reconnectTimer !== null) return;
    const delay = this.reconnectDelay;
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (this.closedByCaller) {
        // Caller called close() while we were waiting for the
        // backoff timer to fire. close() already fired the single
        // pending onClose via pendingDeferredCloseCtx before
        // clearing the timer, so there is nothing left to do here.
        // (Historically this branch was reachable because
        // close() left the deferred notification unfired; now
        // close() always flushes it synchronously, so if we somehow
        // still observe closedByCaller without a pending ctx the
        // notification was already delivered.)
        if (this.pendingDeferredCloseCtx !== null) {
          const pending = this.pendingDeferredCloseCtx;
          this.pendingDeferredCloseCtx = null;
          this.deps.onClose(pending.code, pending.reason);
        }
        return;
      }
      let decision: RelayReconnectDecision = { kind: 'keep' };
      if (this.deps.onReconnect) {
        try {
          const result = await this.deps.onReconnect(ctx);
          decision = normaliseReconnectResult(result);
        } catch (err) {
          // Refresh threw unexpectedly — log and convert to an abort
          // so the reconnect loop halts and the popup can surface a
          // sign-in prompt. Previously we swallowed the error and
          // reconnected with the same (probably invalid) token,
          // which produced a silent retry loop that never reached
          // the user. See browser-use-main-remediation-plan Gap 2.
          const message = err instanceof Error ? err.message : String(err);
          console.warn(
            '[vellum-relay] onReconnect hook threw; aborting reconnect loop',
            err,
          );
          decision = {
            kind: 'abort',
            error:
              `Relay token refresh failed: ${message}. ` +
              `Sign in with Vellum again from the extension popup to reconnect.`,
          };
        }
      }
      if (decision.kind === 'abort') {
        // Refresh is impossible (e.g. cloud token expired and
        // non-interactive renewal failed, or the refresh hook threw).
        // Stop reconnecting and surface the error via onClose so the
        // worker can push an actionable message into chrome.storage
        // for the popup.
        this.closedByCaller = true;
        this.pendingDeferredCloseCtx = null;
        this.deps.onClose(ctx.code, ctx.reason, decision.error);
        return;
      }
      if (decision.kind === 'refreshed') {
        this.deps = {
          ...this.deps,
          mode: { ...this.deps.mode, token: decision.token },
        };
      }
      // 'keep' → leave mode.token alone and fall through to
      // connect() with the existing token.
      //
      // Caller may have called close() concurrently with the refresh
      // hook — re-check before firing onClose or reconnecting.
      if (this.closedByCaller) {
        // Same reasoning as the pre-refresh closedByCaller branch
        // above: close() normally flushes the pending onClose, so
        // the pending ctx should already be null. Defensive flush
        // guards against a rare race where closedByCaller was set
        // via another path.
        if (this.pendingDeferredCloseCtx !== null) {
          const pending = this.pendingDeferredCloseCtx;
          this.pendingDeferredCloseCtx = null;
          this.deps.onClose(pending.code, pending.reason);
        }
        return;
      }
      // Fire onClose once for this lifecycle before we start a fresh
      // connect attempt. The caller sees exactly one onClose per
      // non-normal close, with authError undefined on the reconnect
      // path and set on the abort path. Clear the pending deferred
      // close ctx so a later close() doesn't re-deliver the same
      // notification.
      this.pendingDeferredCloseCtx = null;
      this.deps.onClose(ctx.code, ctx.reason);
      this.connect();
    }, delay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
  }
}

/**
 * Coerce the flexible `onReconnect` return shape into a canonical
 * {@link RelayReconnectDecision}. A plain `string` is treated as a
 * fresh token; `null`/`undefined` is treated as "keep the existing
 * token"; a {@link RelayReconnectDecision} is returned as-is and gives
 * the caller access to the `{ kind: 'abort' }` branch that stops the
 * reconnect loop.
 */
function normaliseReconnectResult(
  result: string | null | void | RelayReconnectDecision,
): RelayReconnectDecision {
  if (typeof result === 'string') return { kind: 'refreshed', token: result };
  if (result && typeof result === 'object' && 'kind' in result) {
    return result;
  }
  return { kind: 'keep' };
}

// ── host_browser result poster ─────────────────────────────────────
//
// The host-browser dispatcher needs a way to ship CDP result envelopes
// back to the daemon. The transport depends on the relay mode:
//
//   - self-hosted: POST to the local daemon's
//     `/v1/host-browser-result` endpoint, authenticated with the
//     stored capability token.
//   - cloud: send the envelope as a `host_browser_result` frame over
//     the existing browser-relay WebSocket. The gateway proxies the
//     frame straight through to the runtime — see
//     `gateway/src/http/routes/browser-relay-websocket.ts`. (Phase 3
//     will land the runtime-side handler for inbound result frames;
//     today the runtime drops them, but the cloud CDP path is
//     feature-flagged off in Phase 2 so this is harmless.)

/**
 * Minimal subset of {@link RelayConnection} that {@link postHostBrowserResult}
 * actually consumes. Used by tests to inject a fake without having to
 * stand up a real WebSocket.
 *
 * `getCurrentMode()` is intentionally part of the surface so callers
 * like worker.ts's `dispatchHostBrowserResult` can read the LIVE mode
 * (including any refreshed token) straight off the connection instead
 * of relying on a module-level snapshot captured at connect time.
 */
export interface RelayConnectionLike {
  isOpen(): boolean;
  send(data: string): void;
  getCurrentMode(): RelayMode;
}

/**
 * Send a `host_browser_event` frame over the relay WebSocket.
 *
 * Unlike {@link postHostBrowserResult}, event frames are unsolicited
 * and do not have an HTTP fallback — the runtime only accepts them
 * through the `/v1/browser-relay` WebSocket's inbound frame handler
 * (see `resolveHostBrowserEvent` in host-browser-routes.ts). When
 * the socket is missing or not currently OPEN the frame is silently
 * dropped: events are inherently lossy (Chrome will fire many more
 * before the next reconnect) and the caller has no useful recovery
 * path.
 *
 * This function is intentionally synchronous — `relay.send()` is
 * fire-and-forget — but the return type stays `void` so callers
 * don't accidentally `await` it and tie the dispatcher's fast path
 * to the microtask queue.
 */
export function postHostBrowserEvent(
  connection: RelayConnectionLike | null,
  event: HostBrowserEventEnvelope,
): void {
  if (!connection || !connection.isOpen()) {
    // Events are lossy — the extension will fire many more of them on
    // the next reconnect, so dropping is the correct behaviour.
    return;
  }
  try {
    connection.send(JSON.stringify(event));
  } catch (err) {
    // Same swallow-and-log posture as the other fire-and-forget
    // helpers: a send failure here must never surface as an unhandled
    // rejection in the service worker.
    console.warn(
      '[vellum-relay] host-browser-event send failed',
      err,
    );
  }
}

/**
 * Send a `host_browser_session_invalidated` frame over the relay
 * WebSocket. Same lossy semantics as {@link postHostBrowserEvent}:
 * when the socket is missing or not OPEN the signal is dropped
 * silently, because the runtime-side session-invalidation registry
 * is advisory and the next successful reconnect will re-establish
 * attach state from scratch anyway.
 */
export function postHostBrowserSessionInvalidated(
  connection: RelayConnectionLike | null,
  event: HostBrowserSessionInvalidatedEnvelope,
): void {
  if (!connection || !connection.isOpen()) {
    return;
  }
  try {
    connection.send(JSON.stringify(event));
  } catch (err) {
    console.warn(
      '[vellum-relay] host-browser-session-invalidated send failed',
      err,
    );
  }
}

/**
 * Ship a host_browser result envelope back to the daemon.
 *
 * In self-hosted mode this POSTs to `${mode.baseUrl}/v1/host-browser-result`
 * with `Authorization: Bearer <mode.token>`. In cloud mode it sends a
 * `{ type: 'host_browser_result', ...result }` frame over the supplied
 * relay connection.
 *
 * The cloud branch is a no-op (with a console.warn) when the connection
 * is missing or not currently open. We deliberately do NOT throw — the
 * dispatcher's error path catches and logs synchronously, but a thrown
 * rejection here would bubble up to the service worker as an unhandled
 * promise rejection.
 */
export async function postHostBrowserResult(
  mode: RelayMode,
  connection: RelayConnectionLike | null,
  result: HostBrowserResultEnvelope,
): Promise<void> {
  if (mode.kind === 'cloud') {
    if (!connection || !connection.isOpen()) {
      console.warn(
        '[vellum-relay] host-browser-result dropped: cloud relay not connected',
      );
      return;
    }
    connection.send(JSON.stringify({ type: 'host_browser_result', ...result }));
    return;
  }

  // self-hosted: POST to the local daemon. The base URL is whatever
  // `buildRelayModeConfig` resolved at connect time (usually
  // `http://127.0.0.1:<relayPort>`).
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (mode.token) headers.authorization = `Bearer ${mode.token}`;
  const url = `${mode.baseUrl.replace(/\/$/, '')}/v1/host-browser-result`;
  const resp = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(result),
  });
  if (!resp.ok) {
    console.warn(
      `[vellum-relay] host-browser-result POST returned ${resp.status}`,
    );
  }
}
