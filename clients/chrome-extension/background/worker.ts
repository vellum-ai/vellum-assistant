/**
 * Chrome MV3 service worker — browser-relay bridge.
 *
 * Connects to either
 *   - the local daemon's browser-relay endpoint
 *     (`ws://127.0.0.1:<relayPort>/v1/browser-relay`), or
 *   - the cloud gateway's browser-relay endpoint
 *     (`wss://<cloud-gateway>/v1/browser-relay`)
 *
 * depending on the `vellum.relayMode` key in chrome.storage.local
 * (default `"self-hosted"` for back-compat). Both transports share the
 * same envelope vocabulary — the choice is strictly about where the
 * socket points and which token is presented on the handshake.
 *
 * Once connected, the worker routes incoming server messages:
 *   - `host_browser_request` / `host_browser_cancel` envelopes are
 *     dispatched to the CDP proxy dispatcher, which drives a
 *     `chrome.debugger` session and POSTs a result envelope back to
 *     the daemon's `/v1/host-browser-result` endpoint.
 *   - Every other payload is logged and discarded.
 */

import {
  signInCloud,
  refreshCloudToken,
  getStoredToken as getStoredCloudToken,
  getStoredTokenRaw as getStoredCloudTokenRaw,
  CLOUD_AUTH_FAILURE_CLOSE_CODES,
  type CloudAuthConfig,
  type StoredCloudToken,
} from './cloud-auth.js';
import {
  decideCloudReconnectAction,
} from './cloud-reconnect-decision.js';
import {
  bootstrapLocalToken,
  getStoredLocalToken,
  type StoredLocalToken,
} from './self-hosted-auth.js';
import {
  createHostBrowserDispatcher,
  type HostBrowserDispatcher,
  type HostBrowserEventEnvelope,
  type HostBrowserRequestEnvelope,
  type HostBrowserCancelEnvelope,
  type HostBrowserResultEnvelope,
  type HostBrowserSessionInvalidatedEnvelope,
} from './host-browser-dispatcher.js';
import {
  RelayConnection,
  postHostBrowserEvent,
  postHostBrowserResult,
  postHostBrowserSessionInvalidated,
  type RelayMode,
  type RelayReconnectContext,
  type RelayReconnectDecision,
} from './relay-connection.js';

// Cloud OAuth defaults — kept here so the popup can stay a thin client and the
// service worker is the single owner of the launchWebAuthFlow lifecycle. This
// avoids the MV3 popup teardown race where closing the popup mid-auth kills
// the awaited promise before the token is persisted.
const CLOUD_GATEWAY_BASE_URL = 'https://api.vellum.ai';
const CLOUD_OAUTH_CLIENT_ID = 'vellum-chrome-extension';

const DEFAULT_RELAY_PORT = 7830;

// ── Stable client instance id ──────────────────────────────────────
//
// Generated once per extension install and persisted in
// chrome.storage.local so it survives service-worker teardown and
// browser restarts. Sent on every WebSocket handshake against the
// runtime's `/v1/browser-relay` endpoint as a `clientInstanceId` query
// param. The runtime uses it to key its ChromeExtensionRegistry under
// (guardianId, clientInstanceId) pairs so multiple parallel installs
// for the same guardian (two Chrome profiles, two desktops) don't
// evict each other on register/unregister.
//
// The value is a UUIDv4, generated via crypto.randomUUID() which is
// available in MV3 service workers. The key is intentionally distinct
// from any persisted auth token so the instance id survives re-pair
// and re-sign-in flows.
const CLIENT_INSTANCE_ID_KEY = 'vellum.clientInstanceId';

/**
 * Read-through cache for the stable client instance id. The value is
 * lazily materialized on first access and persisted in
 * chrome.storage.local; subsequent reads hit the in-memory cache so
 * the hot connect path doesn't have to await storage.
 */
let cachedClientInstanceId: string | null = null;

async function getOrCreateClientInstanceId(): Promise<string> {
  if (cachedClientInstanceId) return cachedClientInstanceId;
  const stored = await chrome.storage.local.get(CLIENT_INSTANCE_ID_KEY);
  const existing = stored[CLIENT_INSTANCE_ID_KEY];
  if (typeof existing === 'string' && existing.length > 0) {
    cachedClientInstanceId = existing;
    return existing;
  }
  const fresh = crypto.randomUUID();
  await chrome.storage.local.set({ [CLIENT_INSTANCE_ID_KEY]: fresh });
  cachedClientInstanceId = fresh;
  console.log(`[vellum-relay] Generated stable clientInstanceId: ${fresh}`);
  return fresh;
}

// Storage key used to surface the most recent auth-related relay error
// to the popup. The popup reads this on open and shows it next to the
// cloud sign-in button. Cleared on a successful connect so stale errors
// don't linger after the user re-signs in.
const RELAY_AUTH_ERROR_KEY = 'vellum.relayAuthError';

interface RelayAuthError {
  message: string;
  mode: 'cloud' | 'self-hosted';
  at: number;
}

async function setRelayAuthError(error: RelayAuthError): Promise<void> {
  try {
    await chrome.storage.local.set({ [RELAY_AUTH_ERROR_KEY]: error });
  } catch (err) {
    console.warn('[vellum-relay] Failed to persist relay auth error', err);
  }
}

async function clearRelayAuthError(): Promise<void> {
  try {
    await chrome.storage.local.remove(RELAY_AUTH_ERROR_KEY);
  } catch (err) {
    console.warn('[vellum-relay] Failed to clear relay auth error', err);
  }
}

// ── Mode selection ─────────────────────────────────────────────────
//
// Existing installs have no `vellum.relayMode` key and must keep using
// the local daemon transport. New installs can flip to cloud via the
// popup radio group.
const RELAY_MODE_KEY = 'vellum.relayMode';
type RelayModeKind = 'self-hosted' | 'cloud';

function isRelayModeKind(v: unknown): v is RelayModeKind {
  return v === 'self-hosted' || v === 'cloud';
}

let relayMode: RelayModeKind = 'self-hosted';
let relayConnection: RelayConnection | null = null;
let shouldConnect = false;

// ── Host browser dispatcher ────────────────────────────────────────
//
// `host_browser_request` / `host_browser_cancel` envelopes arriving on
// the relay WebSocket are routed into the CDP proxy dispatcher, which
// drives a chrome.debugger session and POSTs a result envelope back to
// the daemon's `/v1/host-browser-result` endpoint.

async function resolveHostBrowserTarget(
  cdpSessionId: string | undefined,
): Promise<{ tabId?: number; targetId?: string }> {
  // When the daemon side has an explicit session id (e.g. a flat child
  // session returned from a prior Target.attachToTarget) we route the
  // command by targetId. Otherwise fall back to the most recently
  // active tab in the focused window.
  if (cdpSessionId) {
    return { targetId: cdpSessionId };
  }
  const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (activeTab?.id === undefined) {
    throw new Error('No active tab available to resolve host_browser target');
  }
  return { tabId: activeTab.id };
}

/**
 * Bridge the host-browser dispatcher to the relay-aware
 * {@link postHostBrowserResult} helper.
 *
 * The happy path pulls the current mode straight off the live
 * {@link RelayConnection} via `getCurrentMode()`. This is load-bearing:
 * when `scheduleReconnectWithRefresh` fires after a WebSocket drop, it
 * mints a fresh token and replaces `deps.mode` with a brand new object.
 * Reading via the accessor on every dispatch guarantees the next result
 * POST uses the freshly minted bearer token — a captured snapshot would
 * silently 401/403 forever.
 *
 * When no relay connection exists yet (e.g. a stale result arriving
 * after `disconnect()`), we fall back per the configured relay mode:
 *
 *   - `self-hosted`: POST directly to the local daemon using live
 *     creds resolved from storage.
 *   - `cloud`: warn and drop the envelope. POSTing to localhost in
 *     cloud mode would always fail, and we have no WebSocket to
 *     round-trip through without an active connection.
 */
async function dispatchHostBrowserResult(
  result: HostBrowserResultEnvelope,
): Promise<void> {
  if (relayConnection) {
    // Read the live mode from the active connection so that
    // reconnect-with-refresh token updates propagate to result POSTs
    // automatically.
    const currentMode = relayConnection.getCurrentMode();
    return postHostBrowserResult(currentMode, relayConnection, result);
  }

  // Fallback path: no active connection (e.g. a stale result arriving
  // after `disconnect()`).
  if (relayMode === 'cloud') {
    console.warn(
      '[vellum-relay] host_browser_result dropped: cloud mode but relay not connected',
    );
    return;
  }

  // Self-hosted fallback: POST directly to the local daemon using live
  // creds. Prefer the capability token from the native-messaging pair
  // flow; fall back to the bearer token stored under the gateway
  // pair flow.
  const local = await getStoredLocalToken();
  if (local) {
    const fallbackPort = local.assistantPort ?? (await getRelayPort());
    const fallbackMode: RelayMode = {
      kind: 'self-hosted',
      baseUrl: `http://127.0.0.1:${fallbackPort}`,
      token: local.token,
    };
    return postHostBrowserResult(fallbackMode, null, result);
  }
  console.warn(
    '[vellum-relay] host_browser_result dropped: self-hosted relay not paired',
  );
}

/**
 * Forward a `host_browser_event` envelope over the active relay
 * WebSocket. Events are fire-and-forget: if no connection is open the
 * envelope is dropped. The extension-side dispatcher calls this hook
 * for every `chrome.debugger.onEvent` firing (see PR10); the runtime
 * receives the frame via the WS handler in `http-server.ts` and fans
 * it out through the module-level browser-session event bus.
 *
 * We intentionally do NOT fall back to a POST here because CDP events
 * are lossy — Chrome will emit many more before the next reconnect,
 * so queuing a POST during a WebSocket outage just piles up stale
 * notifications that the runtime cannot act on.
 */
function dispatchHostBrowserEvent(envelope: HostBrowserEventEnvelope): void {
  postHostBrowserEvent(relayConnection, envelope);
}

/**
 * Forward a `host_browser_session_invalidated` envelope over the
 * active relay WebSocket. Same fire-and-forget semantics as
 * {@link dispatchHostBrowserEvent} — a dropped invalidation is
 * recoverable because the extension's own attach cache is cleared
 * in lockstep (see `host-browser-dispatcher.ts`), and the runtime's
 * next command will fail fast with "Unknown browser session" when
 * a stale session handle is reused after a reconnect.
 */
function dispatchHostBrowserSessionInvalidated(
  envelope: HostBrowserSessionInvalidatedEnvelope,
): void {
  postHostBrowserSessionInvalidated(relayConnection, envelope);
}

const hostBrowserDispatcher: HostBrowserDispatcher = createHostBrowserDispatcher({
  resolveTarget: resolveHostBrowserTarget,
  postResult: dispatchHostBrowserResult,
  forwardCdpEvent: dispatchHostBrowserEvent,
  forwardSessionInvalidated: dispatchHostBrowserSessionInvalidated,
});

// ── Storage helpers ─────────────────────────────────────────────────

async function getRelayPort(): Promise<number> {
  const result = await chrome.storage.local.get('relayPort');
  const stored = result.relayPort;
  if (typeof stored === 'number' && stored > 0 && stored <= 65535) return stored;
  if (typeof stored === 'string') {
    const parsed = parseInt(stored, 10);
    if (!isNaN(parsed) && parsed > 0 && parsed <= 65535) return parsed;
  }
  return DEFAULT_RELAY_PORT;
}

// ── Relay connection lifecycle ──────────────────────────────────────

async function loadRelayMode(): Promise<RelayModeKind> {
  const result = await chrome.storage.local.get(RELAY_MODE_KEY);
  const stored = result[RELAY_MODE_KEY];
  return isRelayModeKind(stored) ? stored : 'self-hosted';
}

async function buildRelayModeConfig(kind: RelayModeKind): Promise<RelayMode> {
  if (kind === 'cloud') {
    const stored = await getStoredCloudToken();
    return {
      kind: 'cloud',
      baseUrl: CLOUD_GATEWAY_BASE_URL,
      token: stored?.token ?? null,
    };
  }

  // Self-hosted: prefer the capability token the native-messaging pair
  // flow persisted (see self-hosted-auth.ts). The stored token already
  // carries the assistant runtime port the helper used when it
  // pair-bootstrapped, so we target the runtime directly.
  //
  // No compatibility fallback: self-hosted relay now requires pairing
  // through the native-messaging capability-token flow.
  const local = await getStoredLocalToken();
  if (local) {
    const port = local.assistantPort ?? (await getRelayPort());
    return {
      kind: 'self-hosted',
      baseUrl: `http://127.0.0.1:${port}`,
      token: local.token,
    };
  }
  const port = await getRelayPort();
  return {
    kind: 'self-hosted',
    baseUrl: `http://127.0.0.1:${port}`,
    token: null,
  };
}

// WebSocket close code 1006 ("abnormal closure") is what browsers
// report when a WebSocket connection drops without a clean close
// frame. Both the gateway and the runtime reject invalid/expired
// actor tokens with an HTTP 401 BEFORE the WebSocket upgrade, which
// browsers surface to JS as 1006 — not 4001/4002/4003. So a cloud
// client with a rotated/expired token sees 1006, not an entry in
// CLOUD_AUTH_FAILURE_CLOSE_CODES. We can't unconditionally treat 1006
// as an auth failure, though: it also fires for transient network
// blips (cable unplugged, Chrome sleep/wake, flaky coffee-shop Wi-Fi).
//
// The heuristic below is:
//   1. On the first 1006 close we haven't successfully recovered
//      from, try a token refresh — if the token was the problem a
//      fresh one will let the next connect succeed and the counter
//      will reset.
//   2. After CLOUD_REFRESH_ATTEMPT_CAP consecutive failed refresh
//      attempts we stop reconnecting and abort with an actionable
//      sign-in prompt instead of silently hammering the gateway.
//   3. The counter resets to zero every time a socket successfully
//      opens (see the `onOpen` wiring in `createRelayConnection`).
//
// The pure action-picker lives in `cloud-reconnect-decision.ts` so
// unit tests can exercise the ordering without dragging in the
// service worker surface. This module is responsible for the async
// side effects (reading storage, calling refreshCloudToken, etc.).

/**
 * Count of consecutive refresh attempts made from
 * {@link cloudReconnectHook} since the last successful WebSocket open.
 * Reset to 0 on every `onOpen` callback so a short-lived successful
 * connection effectively re-arms the 1006 recovery path. Exported via
 * {@link resetCloudRefreshAttempts} for the worker's own wiring.
 */
let cloudRefreshAttempts = 0;

function resetCloudRefreshAttempts(): void {
  cloudRefreshAttempts = 0;
}

/**
 * Reconnect hook for cloud mode. Called by {@link RelayConnection} when
 * the WebSocket closes unexpectedly — responsible for deciding whether
 * to reuse the existing token, swap in a freshly refreshed one, or
 * abort the reconnect loop entirely so the popup can prompt the user
 * to sign in again.
 *
 * The pure decision (keep / refresh / abort) is delegated to
 * {@link decideCloudReconnectAction}, which is covered by a direct
 * unit test. This function is the async side-effect wrapper that
 * reads the stored token, consults the decision helper, fires the
 * refresh network call on the `refresh` branch, and maps the
 * outcomes onto a {@link RelayReconnectDecision} for
 * {@link RelayConnection}.
 */
async function cloudReconnectHook(
  ctx: RelayReconnectContext,
): Promise<RelayReconnectDecision> {
  const stored = await getStoredCloudTokenRaw();
  const action = decideCloudReconnectAction({
    ctx,
    stored,
    attempts: cloudRefreshAttempts,
  });
  if (action.kind === 'keep') {
    // Transient network blip with a still-valid token. Keep the
    // existing token and let the relay helper retry.
    return { kind: 'keep' };
  }
  if (action.kind === 'abort') {
    // Budget-exhausted short-circuit for repeated 1006 closes — the
    // decision helper has already generated an actionable sign-in
    // prompt message.
    return { kind: 'abort', error: action.error };
  }

  // action.kind === 'refresh'
  cloudRefreshAttempts += 1;
  const refreshed = await refreshCloudToken({
    gatewayBaseUrl: CLOUD_GATEWAY_BASE_URL,
    clientId: CLOUD_OAUTH_CLIENT_ID,
  });
  if (refreshed) {
    console.log('[vellum-relay] Cloud token refreshed after reconnect');
    return { kind: 'refreshed', token: refreshed.token };
  }

  // Non-interactive refresh is impossible — user must sign in again.
  const authFailure = CLOUD_AUTH_FAILURE_CLOSE_CODES.has(ctx.code);
  const abnormal = ctx.code === 1006;
  const reason = authFailure
    ? 'Cloud relay closed with an auth-failure code'
    : abnormal
      ? 'Cloud relay closed abnormally (code 1006) and token refresh failed'
      : 'Stored cloud token has expired';
  return {
    kind: 'abort',
    error:
      `${reason}. Please sign in with Vellum (cloud) again from the extension popup to reconnect.`,
  };
}

/**
 * Wire a RelayConnection up with the worker's message/open/close
 * callbacks. Does NOT start it.
 */
function createRelayConnection(
  mode: RelayMode,
  clientInstanceId: string,
): RelayConnection {
  return new RelayConnection({
    mode,
    clientInstanceId,
    onOpen: () => {
      console.log(`[vellum-relay] Connected (${mode.kind})`);
      // A successful connect means any persisted auth-error is stale
      // — clear it so the popup stops showing the sign-in prompt.
      void clearRelayAuthError();
      // Re-arm the 1006 recovery path. A short-lived successful
      // connection counts as "we recovered" even if the socket drops
      // seconds later; the next 1006 should try a fresh refresh
      // instead of inheriting the previous chain's attempt count.
      resetCloudRefreshAttempts();
    },
    onMessage: (data) => {
      // Fire-and-forget dispatch — wrap with .catch so a future refactor
      // can't leak an unhandled rejection into the service worker and
      // tear down the relay socket unexpectedly.
      void handleServerMessage(data).catch((err) => {
        console.warn('[vellum-relay] handleServerMessage failed', err);
      });
    },
    onClose: (code, reason, authError) => {
      console.log(
        `[vellum-relay] Disconnected (code=${code}, reason=${reason || 'n/a'})`,
      );
      if (authError) {
        // The reconnect hook decided refresh is impossible — persist
        // the error so the popup can surface it, and mark ourselves
        // as not-trying-to-connect. The user will press Connect again
        // after re-signing in.
        console.warn(`[vellum-relay] Auth refresh impossible: ${authError}`);
        shouldConnect = false;
        void setRelayAuthError({
          message: authError,
          // Read the live mode from the connection if it's still
          // around — by the time onClose fires the connection will
          // have already flipped its own closedByCaller flag, so the
          // module-level `relayMode` is a safe fallback.
          mode: relayMode === 'cloud' ? 'cloud' : 'self-hosted',
          at: Date.now(),
        });
        // Clear the module-level reference so a subsequent
        // connect() starts from a clean slate instead of trying to
        // reuse a connection we've already marked dead.
        relayConnection = null;
      }
    },
    onReconnect: async (ctx) => {
      // Cloud mode: refresh the stored OAuth JWT non-interactively
      // when it's stale or the server closed with an auth-failure
      // code. If refresh is impossible we abort the reconnect loop
      // and surface the error to the popup — see cloudReconnectHook.
      //
      // Self-hosted mode re-reads the stored capability token from
      // `self-hosted-auth.ts` on every reconnect. If pairing data is
      // missing/expired we abort reconnects and surface an actionable
      // error.
      //
      // Pull the live mode through getCurrentMode so a setMode() that
      // flipped us to cloud mid-reconnect still routes through the
      // right branch — mirrors dispatchHostBrowserResult's pattern.
      const liveMode = relayConnection?.getCurrentMode()?.kind ?? mode.kind;
      if (liveMode === 'cloud') {
        return cloudReconnectHook(ctx);
      }
      const local = await getStoredLocalToken();
      if (local?.token) {
        return { kind: 'refreshed', token: local.token };
      }
      return {
        kind: 'abort',
        error:
          'Self-hosted relay token missing or expired. Pair the Vellum assistant again from the extension popup.',
      };
    },
  });
}

/**
 * Thrown by `connect()` when the selected relay mode has no usable
 * token yet. Callers (e.g. the popup connect handler) surface the
 * message verbatim to the user so they can take action — signing in
 * to cloud or re-pairing the local daemon — instead of seeing a
 * silent no-op after pressing "Connect".
 */
class MissingTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MissingTokenError';
  }
}

function missingTokenMessage(kind: RelayModeKind): string {
  if (kind === 'cloud') {
    return 'Sign in with Vellum (cloud) before connecting';
  }
  return 'Pair the Vellum assistant (self-hosted) before connecting';
}

async function connect(): Promise<void> {
  if (relayConnection && relayConnection.isOpen()) return;
  // Defensive: a fresh connect() always starts the 1006 refresh
  // budget from scratch. The counter is normally reset from onOpen,
  // but if a previous session exhausted the cap (so onOpen never
  // fired for the aborted attempt) and the user then signed in again
  // and clicked Connect, the carried-over counter would cause the
  // first 1006 in the new session to immediately land in the abort
  // branch. Resetting here guarantees a fresh Connect gets the full
  // refresh budget regardless of prior session state.
  resetCloudRefreshAttempts();
  // A fresh connect attempt supersedes any previously persisted
  // auth-error — the user either just signed back in or is explicitly
  // retrying, and we want the popup to stop nagging.
  await clearRelayAuthError();
  // Re-read the live relay mode from storage at connect time. The
  // module-level `relayMode` variable is only refreshed asynchronously
  // via chrome.storage.onChanged, so trusting it races against a popup
  // that toggles the radio and immediately clicks Connect. Reading from
  // storage here makes the connect flow deterministic.
  //
  // The module-level `relayMode` is still updated to match so other code
  // paths (status queries, disconnect, result routing) stay consistent
  // with the mode we're about to connect with.
  const liveMode = await loadRelayMode();
  relayMode = liveMode;
  const mode = await buildRelayModeConfig(liveMode);
  if (!mode.token) {
    const msg = missingTokenMessage(mode.kind);
    console.warn(`[vellum-relay] ${msg}`);
    throw new MissingTokenError(msg);
  }
  // Tear down any stale instance before constructing a new one. This
  // keeps the close/reconnect lifecycle simple — one RelayConnection
  // per live socket, no hidden state carried across mode switches.
  if (relayConnection) {
    relayConnection.close(1000, 'reconfigured');
  }
  // Resolve the stable per-install id up front so every handshake
  // (including reconnects on the freshly constructed RelayConnection)
  // sends the same value. The call is cached after the first lookup.
  const clientInstanceId = await getOrCreateClientInstanceId();
  relayConnection = createRelayConnection(mode, clientInstanceId);
  relayConnection.start();
}

function disconnect(): void {
  if (relayConnection) {
    relayConnection.close(1000, 'User disconnected');
    relayConnection = null;
  }
}

/**
 * Handle a runtime switch of `vellum.relayMode` (e.g. the popup radio
 * group flipped). Closes any current socket and opens a new one in the
 * new mode — see plan PR 14 step 2.
 */
async function applyModeChange(newKind: RelayModeKind): Promise<void> {
  if (newKind === relayMode) return;
  relayMode = newKind;
  if (!shouldConnect) return;
  disconnect();
  try {
    await connect();
  } catch (err) {
    // The user switched modes before signing in / pairing. Leave the
    // extension disconnected and let the next user-initiated connect
    // bubble the error up through the popup message handler.
    if (err instanceof MissingTokenError) {
      shouldConnect = false;
      console.warn(
        `[vellum-relay] Mode switch to ${newKind} left disconnected: ${err.message}`,
      );
      return;
    }
    throw err;
  }
}

// ── Server message dispatch ─────────────────────────────────────────

async function handleServerMessage(raw: string): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn('[vellum-relay] Failed to parse server message');
    return;
  }

  if (
    parsed !== null &&
    typeof parsed === 'object' &&
    'type' in parsed &&
    typeof (parsed as { type: unknown }).type === 'string'
  ) {
    const envelopeType = (parsed as { type: string }).type;
    if (envelopeType === 'host_browser_request') {
      await hostBrowserDispatcher.handle(parsed as HostBrowserRequestEnvelope);
      return;
    }
    if (envelopeType === 'host_browser_cancel') {
      hostBrowserDispatcher.cancel(parsed as HostBrowserCancelEnvelope);
      return;
    }
  }

  console.warn('[vellum-relay] Unknown message type:', parsed);
}

// ── Extension message listener (from popup) ─────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponseFn) => {
  if (message.type === 'connect') {
    shouldConnect = true;
    connect()
      .then(() => sendResponseFn({ ok: true }))
      .catch((err) => {
        // Reset shouldConnect so a subsequent storage change or
        // bootstrap doesn't silently retry a doomed connect. The user
        // will press Connect again after signing in / pairing.
        shouldConnect = false;
        const errorMessage = err instanceof Error ? err.message : String(err);
        sendResponseFn({ ok: false, error: errorMessage });
      });
    return true; // async
  }
  if (message.type === 'disconnect') {
    shouldConnect = false;
    disconnect();
    sendResponseFn({ ok: true });
    return false;
  }
  if (message.type === 'get_status') {
    sendResponseFn({
      connected: relayConnection !== null && relayConnection.isOpen(),
      mode: relayMode,
    });
    return false;
  }
  if (message.type === 'cloud-auth-sign-in') {
    // Run the OAuth flow in the service worker — not the popup — so the
    // awaited promise survives the popup losing focus during the Chrome
    // identity window. The popup just awaits this message response.
    const config: CloudAuthConfig = {
      gatewayBaseUrl:
        typeof message.gatewayBaseUrl === 'string' ? message.gatewayBaseUrl : CLOUD_GATEWAY_BASE_URL,
      clientId:
        typeof message.clientId === 'string' ? message.clientId : CLOUD_OAUTH_CLIENT_ID,
    };
    signInCloud(config)
      .then((stored: StoredCloudToken) => sendResponseFn({ ok: true, token: stored }))
      .catch((err) => sendResponseFn({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    return true; // async
  }
  if (message.type === 'self-hosted-pair') {
    // Mirror the cloud-auth-sign-in pattern: run the native-messaging
    // bootstrap in the service worker so the popup closing mid-pair
    // can't tear down the awaited promise before the token is persisted.
    // chrome.runtime.connectNative also requires the "nativeMessaging"
    // permission, which is declared in manifest.json.
    bootstrapLocalToken()
      .then((stored: StoredLocalToken) => sendResponseFn({ ok: true, token: stored }))
      .catch((err) => sendResponseFn({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    return true; // async
  }
});

// Auto-connect on service worker start if previously connected.
async function bootstrap(): Promise<void> {
  relayMode = await loadRelayMode();
  const { autoConnect } = await chrome.storage.local.get('autoConnect');
  if (autoConnect !== true) return;
  shouldConnect = true;
  try {
    await connect();
  } catch (err) {
    // A missing token at auto-connect time is not a hard failure —
    // the user will see the disconnected state in the popup and can
    // sign in / pair to try again. Log and move on.
    if (err instanceof MissingTokenError) {
      shouldConnect = false;
      console.warn(`[vellum-relay] Skipping auto-connect: ${err.message}`);
      return;
    }
    throw err;
  }
}

bootstrap();

// Keep relay mode live-updatable from the popup without requiring the
// service worker to restart.
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  if (RELAY_MODE_KEY in changes) {
    const newValue = changes[RELAY_MODE_KEY]?.newValue;
    if (isRelayModeKind(newValue)) {
      console.log(`[vellum-relay] Relay mode updated: ${newValue}`);
      void applyModeChange(newValue);
    }
  }
});
