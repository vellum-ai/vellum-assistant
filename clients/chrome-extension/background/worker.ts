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
  getStoredToken as getStoredCloudToken,
  type CloudAuthConfig,
  type StoredCloudToken,
} from './cloud-auth.js';
import {
  bootstrapLocalToken,
  type StoredLocalToken,
} from './self-hosted-auth.js';
import {
  createHostBrowserDispatcher,
  type HostBrowserDispatcher,
  type HostBrowserRequestEnvelope,
  type HostBrowserCancelEnvelope,
  type HostBrowserResultEnvelope,
} from './host-browser-dispatcher.js';
import {
  RelayConnection,
  postHostBrowserResult,
  type RelayMode,
} from './relay-connection.js';

// Cloud OAuth defaults — kept here so the popup can stay a thin client and the
// service worker is the single owner of the launchWebAuthFlow lifecycle. This
// avoids the MV3 popup teardown race where closing the popup mid-auth kills
// the awaited promise before the token is persisted.
const CLOUD_GATEWAY_BASE_URL = 'https://api.vellum.ai';
const CLOUD_OAUTH_CLIENT_ID = 'vellum-chrome-extension';

const DEFAULT_RELAY_PORT = 7830;

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
  // creds.
  const [token, port] = await Promise.all([getBearerToken(), getRelayPort()]);
  const fallbackMode: RelayMode = {
    kind: 'self-hosted',
    baseUrl: `http://127.0.0.1:${port}`,
    token,
  };
  return postHostBrowserResult(fallbackMode, null, result);
}

const hostBrowserDispatcher: HostBrowserDispatcher = createHostBrowserDispatcher({
  resolveTarget: resolveHostBrowserTarget,
  postResult: dispatchHostBrowserResult,
});

// ── Storage helpers ─────────────────────────────────────────────────

async function getBearerToken(): Promise<string | null> {
  const result = await chrome.storage.local.get('bearerToken');
  return typeof result.bearerToken === 'string' ? result.bearerToken : null;
}

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

/**
 * Fetch a fresh bearer token from the gateway's localhost-only endpoint
 * and persist it for future connections.
 */
async function refreshToken(): Promise<boolean> {
  try {
    const port = await getRelayPort();
    const resp = await fetch(`http://127.0.0.1:${port}/v1/browser-relay/token`);
    if (!resp.ok) return false;
    const data = await resp.json();
    if (typeof data.token !== 'string') return false;
    await chrome.storage.local.set({ bearerToken: data.token });
    console.log('[vellum-relay] Token refreshed from gateway');
    return true;
  } catch {
    console.warn('[vellum-relay] Failed to refresh token from gateway');
    return false;
  }
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
  // Self-hosted: re-use the existing local-token flow. The plan explicitly
  // defers the switch to PR 13's getStoredLocalToken() to a follow-up.
  const [token, port] = await Promise.all([getBearerToken(), getRelayPort()]);
  return {
    kind: 'self-hosted',
    baseUrl: `http://127.0.0.1:${port}`,
    token,
  };
}

/**
 * Wire a RelayConnection up with the worker's message/open/close
 * callbacks. Does NOT start it.
 */
function createRelayConnection(mode: RelayMode): RelayConnection {
  return new RelayConnection({
    mode,
    onOpen: () => {
      console.log(`[vellum-relay] Connected (${mode.kind})`);
    },
    onMessage: (data) => {
      // Fire-and-forget dispatch — wrap with .catch so a future refactor
      // can't leak an unhandled rejection into the service worker and
      // tear down the relay socket unexpectedly.
      void handleServerMessage(data).catch((err) => {
        console.warn('[vellum-relay] handleServerMessage failed', err);
      });
    },
    onClose: (code, reason) => {
      console.log(`[vellum-relay] Disconnected (code=${code}, reason=${reason || 'n/a'})`);
    },
    onReconnect: async () => {
      // Self-hosted: attempt to mint a fresh gateway token. Cloud: no-op
      // for now — the cloud token is stored independently via OAuth and
      // we'd rather surface the failure to the user than silently loop.
      if (mode.kind === 'self-hosted') {
        const ok = await refreshToken();
        if (ok) {
          const refreshed = await getBearerToken();
          return refreshed;
        }
      }
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
  relayConnection = createRelayConnection(mode);
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
// Refresh the self-hosted token first so we don't reconnect with stale
// credentials — cloud-mode auto-connect just reads the stored OAuth
// token and trusts the caller to re-sign in if it's expired.
async function bootstrap(): Promise<void> {
  relayMode = await loadRelayMode();
  const { autoConnect } = await chrome.storage.local.get('autoConnect');
  if (autoConnect !== true) return;
  shouldConnect = true;
  if (relayMode === 'self-hosted') {
    await refreshToken();
  }
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
