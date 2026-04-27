/**
 * Chrome MV3 service worker — browser-relay bridge.
 *
 * Connects to the local assistant's browser-relay endpoint
 * (`ws://127.0.0.1:<port>/v1/browser-relay`) for self-hosted assistants,
 * or to the SSE `/events` endpoint for vellum-cloud assistants.
 *
 * The worker owns the full connect lifecycle:
 *   - **One-click Connect**: When the popup sends `connect` with
 *     `interactive=true`, the worker auto-bootstraps credentials
 *     (local pair) before opening the socket. The user never needs
 *     to manually pair.
 *   - **Auto-connect on reopen**: After a successful connect, the
 *     `autoConnect` storage flag is set. On service-worker startup
 *     the `bootstrap()` function reads this flag and reconnects
 *     non-interactively using stored credentials.
 *   - **Pause**: The `pause` message clears the `autoConnect` flag
 *     and tears down the socket. Credentials are preserved so the
 *     next Connect is instant.
 *
 * Once connected, the worker routes incoming server messages:
 *   - `host_browser_request` / `host_browser_cancel` envelopes are
 *     dispatched to the CDP proxy dispatcher, which drives a
 *     `chrome.debugger` session and POSTs a result envelope back to
 *     the assistant's `/v1/host-browser-result` endpoint.
 *   - Every other payload is logged and discarded.
 */

import {
  type ExtensionEnvironment,
  cloudUrlsForEnvironment,
  parseExtensionEnvironment,
  resolveBuildDefaultEnvironment,
} from './extension-environment.js';
import {
  type AssistantAuthProfile,
} from './assistant-auth-profile.js';
import {
  bootstrapDirectPairToken,
  getStoredLocalToken,
  getStoredGatewayUrl,
  setStoredGatewayUrl,
  isLocalTokenStale,
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
} from './relay-connection.js';
import { SseConnection, type SseMode } from './sse-connection.js';
import { fetchAssistants } from './cloud-api.js';
import {
  startCloudLogin,
  getStoredSession,
  clearSession,
  getSelectedAssistant,
  storeSelectedAssistant,
  clearSelectedAssistant,
} from './cloud-auth.js';

// ── Environment resolution ──────────────────────────────────────────
//
// The effective environment drives URL resolution. Precedence:
//   1. Popup override persisted in chrome.storage.local
//   2. Build-time default injected via `--define` at bundle time
//   3. Fallback to 'production' (see resolveBuildDefaultEnvironment)
//
// The popup can read and write the override via `environment-get` and
// `environment-set` worker messages without requiring an extension reload.

const ENVIRONMENT_OVERRIDE_KEY = 'vellum.environmentOverride';

/**
 * Resolve the effective environment by checking for a popup-persisted
 * override first, then falling back to the build-time default.
 */
async function getEffectiveEnvironment(): Promise<ExtensionEnvironment> {
  const result = await chrome.storage.local.get(ENVIRONMENT_OVERRIDE_KEY);
  const override = result[ENVIRONMENT_OVERRIDE_KEY];
  if (typeof override === 'string') {
    const parsed = parseExtensionEnvironment(override);
    if (parsed) return parsed;
  }
  return resolveBuildDefaultEnvironment();
}

/**
 * Read the raw override value from storage (null when unset).
 */
async function getOverrideEnvironment(): Promise<ExtensionEnvironment | null> {
  const result = await chrome.storage.local.get(ENVIRONMENT_OVERRIDE_KEY);
  const override = result[ENVIRONMENT_OVERRIDE_KEY];
  if (typeof override === 'string') {
    return parseExtensionEnvironment(override);
  }
  return null;
}

/**
 * Persist an environment override. Pass `null` to clear.
 */
async function setOverrideEnvironment(env: ExtensionEnvironment | null): Promise<void> {
  if (env === null) {
    await chrome.storage.local.remove(ENVIRONMENT_OVERRIDE_KEY);
  } else {
    await chrome.storage.local.set({ [ENVIRONMENT_OVERRIDE_KEY]: env });
  }
}

/**
 * Remove all stored auth tokens. Called when the effective environment
 * changes so stale tokens minted against the previous environment are
 * not reused on the next connect.
 */
async function invalidateAuthTokens(): Promise<void> {
  const all = await chrome.storage.local.get(null);
  const keysToRemove = Object.keys(all).filter(
    (k) => k.startsWith('vellum.localCapabilityToken'),
  );
  await chrome.storage.local.remove(keysToRemove);
}

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

// Storage key that controls auto-connect on service-worker startup.
// Set to `true` after a successful user-initiated connect, cleared to
// `false` by the `pause` action so the extension stays quiet until
// the user explicitly reconnects.
const AUTO_CONNECT_KEY = 'autoConnect';

// Storage key used to surface the most recent auth-related relay error
// to the popup. The popup reads this on open and shows it next to the
// sign-in button. Cleared on a successful connect so stale errors
// don't linger after the user re-signs in.
const RELAY_AUTH_ERROR_KEY = 'vellum.relayAuthError';

interface RelayAuthError {
  message: string;
  mode: 'self-hosted' | 'vellum-cloud';
  at: number;
  debugDetails?: string;
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

function serializeWorkerError(err: unknown): {
  error: string;
  debugDetails?: string;
} {
  return {
    error: err instanceof Error ? err.message : String(err),
  };
}

/**
 * Persist the auto-connect flag. Called after a successful user-initiated
 * connect so the next service-worker startup (e.g. browser reopen)
 * automatically reconnects.
 */
async function setAutoConnect(enabled: boolean): Promise<void> {
  try {
    await chrome.storage.local.set({ [AUTO_CONNECT_KEY]: enabled });
  } catch (err) {
    console.warn('[vellum-relay] Failed to persist autoConnect flag', err);
  }
}

// ── Self-hosted gateway URL ──────────────────────────────────────────
//
// For self-hosted assistants the user provides a gateway URL (defaulting
// to http://127.0.0.1:7830). The popup reads/writes this via
// `gateway-url-get` and `gateway-url-set` messages. The connect flow
// uses it to POST directly to `/v1/browser-extension-pair` and then
// open a WebSocket relay to the same host.

// ── Connection health state ──────────────────────────────────────────
//
// Explicit state machine for the relay connection lifecycle. The popup
// consumes this via `get_status` instead of inferring state from the
// `connected` boolean and ad-hoc error fields.
//
// States:
//   - `paused`       — user explicitly paused; autoConnect is false.
//   - `connecting`    — initial connect attempt in progress.
//   - `connected`     — relay WebSocket is OPEN.
//   - `reconnecting`  — socket dropped unexpectedly; reconnect in progress.
//   - `auth_required` — credentials are missing/expired and non-interactive
//                       refresh failed. User must sign in / re-pair.
//   - `error`         — unrecoverable non-auth error (e.g. native host
//                       not installed, unsupported topology).

/**
 * Structured connection health state exposed to the popup via
 * `get_status`. Transitions are driven by the connect, reconnect,
 * close, and pause actions in the worker.
 */
export type ConnectionHealthState =
  | 'paused'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'auth_required'
  | 'error';

/**
 * Detail fields attached to the current health state. Populated on
 * disconnect / error transitions and cleared on successful connect.
 */
export interface ConnectionHealthDetail {
  /** WebSocket close code from the last unexpected disconnect. */
  lastDisconnectCode?: number;
  /** Human-readable error message from the last failure. */
  lastErrorMessage?: string;
  /** Epoch ms of the most recent health state change. */
  lastChangeAt: number;
}

let connectionHealth: ConnectionHealthState = 'paused';
let connectionHealthDetail: ConnectionHealthDetail = {
  lastChangeAt: Date.now(),
};

/**
 * Transition the connection health state. Every transition updates
 * `lastChangeAt`. Additional detail fields (disconnect code, error
 * message) are set by the caller via the optional `detail` argument.
 */
function setConnectionHealth(
  state: ConnectionHealthState,
  detail?: Partial<Omit<ConnectionHealthDetail, 'lastChangeAt'>>,
): void {
  connectionHealth = state;
  connectionHealthDetail = {
    ...connectionHealthDetail,
    ...detail,
    lastChangeAt: Date.now(),
  };
  // Clear stale error fields when entering a non-error state so
  // previous `lastErrorMessage` / `lastDisconnectCode` values don't
  // bleed into unrelated transitions (e.g. auth_required → paused).
  if (state === 'connected' || state === 'paused' || state === 'connecting') {
    delete connectionHealthDetail.lastDisconnectCode;
    delete connectionHealthDetail.lastErrorMessage;
  }
}

// ── Connection state ───────────────────────────────────────────────
//
// The connect path is driven by the auth profile: `self-hosted` uses
// the user-provided gateway URL + direct pair token, `vellum-cloud` uses
// SSE + WorkOS session auth.

/**
 * The auth profile of the currently connected (or last-attempted)
 * assistant. Updated on every `connect()` call. Used by the onClose
 * handler to determine the error mode label.
 */
let currentAuthProfile: AssistantAuthProfile | null = null;

let relayConnection: RelayConnection | null = null;
let sseConnection: SseConnection | null = null;
let shouldConnect = false;

// ── Host browser dispatcher ────────────────────────────────────────
//
// `host_browser_request` / `host_browser_cancel` envelopes arriving on
// the relay WebSocket are routed into the CDP proxy dispatcher, which
// drives a chrome.debugger session and POSTs a result envelope back to
// the assistant's `/v1/host-browser-result` endpoint.

async function resolveHostBrowserTarget(
  cdpSessionId: string | undefined,
): Promise<{ tabId?: number; targetId?: string }> {
  if (cdpSessionId) {
    // Chrome tab IDs are positive integers. CDP targetIds are opaque
    // non-numeric strings (hex, UUIDs, etc.). Route canonical decimal
    // digit strings as tabId for chrome.debugger.attach({ tabId });
    // route everything else as targetId. The regex guard rejects hex
    // literals ("0x10"), exponential notation ("1e3"), and whitespace-
    // padded values that Number() would silently coerce to integers.
    if (/^\d+$/.test(cdpSessionId)) {
      const asNumber = Number(cdpSessionId);
      if (asNumber > 0 && Number.isSafeInteger(asNumber)) {
        return { tabId: asNumber };
      }
    }
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
 * after `disconnect()`), we fall back by POSTing directly to the local
 * assistant using live creds resolved from storage.
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

  // Cloud SSE path: POST the result to the cloud assistant's runtime
  // URL. The SSE stream is read-only so results must go via HTTP.
  // We POST directly here (rather than via postHostBrowserResult) so
  // we can include cross-origin credentials and the SSE mode's token.
  if (sseConnection && sseConnection.isOpen()) {
    const mode = sseConnection.getMode();
    const baseUrl = mode.runtimeUrl.replace(/\/$/, '');
    const url = `${baseUrl}/v1/host-browser-result`;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    };
    if (mode.token) {
      headers['authorization'] = `Bearer ${mode.token}`;
    }
    if (mode.organizationId) {
      headers['Vellum-Organization-Id'] = mode.organizationId;
    }
    const resp = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(result),
      credentials: 'include',
    });
    if (!resp.ok) {
      console.warn(
        '[vellum-sse] host-browser-result POST failed',
        resp.status,
      );
    }
    return;
  }

  // Fallback path: no active connection (e.g. a stale result arriving
  // after `disconnect()`). Try the stored token for the current gateway URL.
  const gatewayUrl = await getStoredGatewayUrl();
  const local = await getStoredLocalToken(gatewayUrl);
  if (local) {
    const fallbackMode: RelayMode = {
      kind: 'self-hosted',
      baseUrl: gatewayUrl,
      token: local.token,
    };
    return postHostBrowserResult(fallbackMode, null, result);
  }
  console.warn(
    '[vellum-relay] host_browser_result dropped: no active connection',
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

/** Storage key for the user's chosen connection mode (welcome screen). */
const USER_MODE_KEY = 'vellum.userMode';

async function getStoredUserMode(): Promise<'self-hosted' | 'cloud' | null> {
  try {
    const result = await chrome.storage.local.get(USER_MODE_KEY);
    const stored = result[USER_MODE_KEY];
    if (stored === 'self-hosted' || stored === 'cloud') return stored;
  } catch { /* best-effort */ }
  return null;
}

async function setStoredUserMode(mode: 'self-hosted' | 'cloud'): Promise<void> {
  await chrome.storage.local.set({ [USER_MODE_KEY]: mode });
}

async function clearStoredUserMode(): Promise<void> {
  await chrome.storage.local.remove(USER_MODE_KEY);
}

/**
 * Read a local capability token from the legacy unscoped storage key
 * (`vellum.localCapabilityToken`). Used as a backward-compatible
 * fallback when no assistant is selected.
 */
// ── Relay connection lifecycle ──────────────────────────────────────

/**
 * Build the {@link RelayMode} for the self-hosted connect path.
 * Reads the stored gateway URL and any existing capability token.
 *
 * If the stored token is stale, attempts a silent re-pair before
 * returning. Returns a token-less mode on failure so the caller
 * can surface a missing-token error.
 */
async function buildSelfHostedRelayMode(): Promise<RelayMode> {
  const gatewayUrl = await getStoredGatewayUrl();
  let local = await getStoredLocalToken(gatewayUrl);

  if (isLocalTokenStale(local)) {
    try {
      local = await bootstrapDirectPairToken(gatewayUrl);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.warn(
        `[vellum-relay] Silent direct pair token refresh failed: ${detail}`,
      );
    }
  }

  if (local) {
    return {
      kind: 'self-hosted',
      baseUrl: gatewayUrl,
      token: local.token,
    };
  }

  return {
    kind: 'self-hosted',
    baseUrl: gatewayUrl,
    token: null,
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
      setConnectionHealth('connected');
      // A successful connect means any persisted auth-error is stale
      // — clear it so the popup stops showing the sign-in prompt.
      void clearRelayAuthError();

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
        setConnectionHealth('auth_required', {
          lastDisconnectCode: code,
          lastErrorMessage: authError,
        });
        void setRelayAuthError({
          message: authError,
          mode: 'self-hosted',
          at: Date.now(),
        });
        // Clear the module-level reference so a subsequent
        // connect() starts from a clean slate instead of trying to
        // reuse a connection we've already marked dead.
        relayConnection = null;
      } else if (shouldConnect) {
        // Unexpected disconnect but we intend to stay connected —
        // the RelayConnection will attempt to reconnect automatically.
        setConnectionHealth('reconnecting', {
          lastDisconnectCode: code,
        });
      }
    },
    onReconnect: async (_ctx) => {
      // Re-read the stored capability token from `self-hosted-auth.ts`
      // on every reconnect. If pairing data is missing/expired we abort
      // reconnects and surface an actionable error.
      const gatewayUrl = await getStoredGatewayUrl();
      let local = await getStoredLocalToken(gatewayUrl);

      if (isLocalTokenStale(local)) {
        try {
          local = await bootstrapDirectPairToken(gatewayUrl);
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          console.warn(
            `[vellum-relay] Silent direct pair token refresh on reconnect failed: ${detail}`,
          );
        }
      }

      if (local?.token) {
        return { kind: 'refreshed', token: local.token };
      }
      return {
        kind: 'abort',
        error:
          'Self-hosted relay token missing or expired. Check the Gateway URL and make sure the assistant is running.',
      };
    },
  });
}

/**
 * Wire an SseConnection up with the worker's message/open/close
 * callbacks for vellum-cloud assistants. Does NOT start it.
 */
function createSseConnection(mode: SseMode): SseConnection {
  return new SseConnection({
    mode,
    onOpen: () => {
      console.log('[vellum-sse] Connected to cloud assistant');
      setConnectionHealth('connected');
      void clearRelayAuthError();
    },
    onMessage: (data) => {
      void handleSseMessage(data).catch((err) => {
        console.warn('[vellum-sse] handleSseMessage failed', err);
      });
    },
    onClose: (authError) => {
      console.log(
        `[vellum-sse] Disconnected${authError ? ` (auth: ${authError})` : ''}`,
      );
      if (authError) {
        shouldConnect = false;
        setConnectionHealth('auth_required', {
          lastErrorMessage: authError,
        });
        void setRelayAuthError({
          message: authError,
          mode: 'vellum-cloud',
          at: Date.now(),
        });
        sseConnection = null;
      } else if (shouldConnect) {
        setConnectionHealth('reconnecting');
      }
    },
  });
}

/**
 * Handle an incoming SSE event payload from a vellum-cloud assistant.
 * The /events endpoint emits AssistantEvent envelopes; the
 * `host_browser_request` / `host_browser_cancel` events are dispatched
 * to the CDP proxy dispatcher, matching the relay WebSocket behavior.
 */
async function handleSseMessage(data: unknown): Promise<void> {
  if (!data || typeof data !== 'object') return;

  // The /events SSE endpoint wraps messages in an AssistantEvent envelope:
  // { id, assistantId, message: { type, ... } }
  const envelope = data as { message?: unknown };
  const message = envelope.message;
  if (!message || typeof message !== 'object') return;

  const typed = message as { type?: unknown };
  if (typeof typed.type !== 'string') return;

  if (typed.type === 'host_browser_request') {
    await hostBrowserDispatcher.handle(message as HostBrowserRequestEnvelope);
    return;
  }
  if (typed.type === 'host_browser_cancel') {
    hostBrowserDispatcher.cancel(message as HostBrowserCancelEnvelope);
    return;
  }

  // Other event types (text deltas, tool calls, etc.) are not handled
  // by the extension — they're consumed by the chat UI clients.
}

/**
 * Thrown by `connect()` when the selected assistant's auth profile
 * has no usable token and the interactive bootstrap also failed, or
 * when the topology is unsupported. Callers (e.g. the popup connect
 * handler) surface the message verbatim so the user can take action
 * via the Troubleshooting controls (re-pair or re-sign-in) or by
 * updating the extension.
 */
class MissingTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MissingTokenError';
  }
}

/**
 * Generate an actionable error message for a missing token, scoped
 * to the selected assistant's auth profile.
 */
function missingTokenMessage(profile: AssistantAuthProfile | null): string {
  if (profile === 'self-hosted') {
    return "Pairing with gateway failed \u2014 check the Gateway URL and make sure the assistant is running, then try again";
  }
  if (profile === 'vellum-cloud') {
    return 'Vellum cloud session expired or unavailable. Sign in again to reconnect.';
  }
  if (profile === 'unsupported') {
    return 'This assistant uses an unsupported topology. Please update the Vellum extension.';
  }
  return 'Configure a gateway URL and turn Connection on to connect';
}

// ── Connect options ────────────────────────────────────────────────
//
// Threading an explicit `interactive` flag through the connect flow
// lets the worker decide whether missing/stale credentials should
// trigger an interactive sign-in/pair flow or produce an immediate
// error. User-initiated Connect passes `interactive: true`; non-user-
// initiated paths (auto-connect on bootstrap, reconnect) pass `false`.

/**
 * Options bag threaded through {@link connect} to control whether
 * missing credentials trigger an interactive auth bootstrap.
 *
 * - `interactive: true` — the worker will auto-bootstrap auth when
 *   credentials are missing or stale. For `self-hosted` this runs
 *   `bootstrapDirectPairToken`.
 * - `interactive: false` — the worker will NOT launch an interactive
 *   flow. Missing credentials produce a {@link MissingTokenError}.
 */
interface ConnectOptions {
  interactive: boolean;
}

/**
 * Resolve credentials before the socket opens. For self-hosted, if
 * the token is missing and the connect is interactive, bootstraps a
 * fresh token via direct HTTP pair to the gateway.
 */
async function connectPreflight(
  authProfile: AssistantAuthProfile | null,
  mode: RelayMode,
  options: ConnectOptions,
): Promise<RelayMode> {
  if (mode.token) {
    return mode;
  }

  if (authProfile === 'self-hosted') {
    if (!options.interactive) {
      throw new MissingTokenError(missingTokenMessage('self-hosted'));
    }
    const gatewayUrl = await getStoredGatewayUrl();
    const stored = await bootstrapDirectPairToken(gatewayUrl);
    return {
      kind: 'self-hosted',
      baseUrl: gatewayUrl,
      token: stored.token,
    };
  }

  throw new MissingTokenError(missingTokenMessage(authProfile));
}

// Serialization lock: if a connect is already in progress, subsequent
// callers await the existing attempt rather than launching a concurrent
// preflight. This prevents duplicate auth/pair flows when multiple
// connect calls arrive before the first socket opens (e.g., repeated
// user action or overlapping message paths).
//
// Exception: an interactive connect (user-initiated) always supersedes a
// non-interactive one (bootstrap). If the in-flight connect is
// non-interactive and the new caller is interactive, we discard the
// in-flight promise and start a fresh interactive connect so the user
// gets the interactive auth flow they expect.
let connectInFlight: Promise<void> | null = null;
let connectInFlightInteractive = false;

async function connect(options: ConnectOptions = { interactive: false }): Promise<void> {
  if (connectInFlight && (connectInFlightInteractive || !options.interactive)) {
    return connectInFlight;
  }
  connectInFlightInteractive = !!options.interactive;
  connectInFlight = doConnect(options);
  try {
    await connectInFlight;
  } finally {
    connectInFlight = null;
    connectInFlightInteractive = false;
  }
}

/**
 * Helper: is any transport (relay WebSocket or SSE) currently open?
 */
function isAnyConnectionOpen(): boolean {
  return (
    (relayConnection !== null && relayConnection.isOpen()) ||
    (sseConnection !== null && sseConnection.isOpen())
  );
}

async function doConnect(options: ConnectOptions): Promise<void> {
  if (isAnyConnectionOpen()) return;
  setConnectionHealth('connecting');

  // A fresh connect attempt supersedes any previously persisted
  // auth-error — the user either just signed back in or is explicitly
  // retrying, and we want the popup to stop nagging.
  await clearRelayAuthError();

  // Tear down any stale connections before constructing new ones.
  teardownConnections();

  const userMode = await getStoredUserMode();

  if (userMode === 'cloud') {
    // Cloud mode: connect via SSE to the platform API.
    currentAuthProfile = 'vellum-cloud';
    const session = await getStoredSession();
    const selectedAssistant = await getSelectedAssistant();
    if (!session || !selectedAssistant) {
      setConnectionHealth('auth_required', {
        lastErrorMessage: 'Sign in and select an assistant to connect.',
      });
      return;
    }
    const env = await getEffectiveEnvironment();
    const { apiBaseUrl } = cloudUrlsForEnvironment(env);
    sseConnection = createSseConnection({
      kind: 'vellum-cloud',
      runtimeUrl: apiBaseUrl,
      assistantId: selectedAssistant.id,
      token: null, // session cookie handles auth
      organizationId: session.organizationId,
    });
    sseConnection.start();
  } else {
    // Self-hosted: connect via WebSocket relay to the local gateway.
    currentAuthProfile = 'self-hosted';
    const rawMode = await buildSelfHostedRelayMode();
    const mode = await connectPreflight(currentAuthProfile, rawMode, options);
    const clientInstanceId = await getOrCreateClientInstanceId();
    relayConnection = createRelayConnection(mode, clientInstanceId);
    relayConnection.start();
  }
}

/**
 * Tear down all active connections without resetting `shouldConnect`.
 * Used by `doConnect` to clean up stale instances before constructing
 * a new connection.
 */
function teardownConnections(): void {
  if (relayConnection) {
    relayConnection.close(1000, 'reconfigured');
    relayConnection = null;
  }
  if (sseConnection) {
    sseConnection.close();
    sseConnection = null;
  }
}

function disconnect(): void {
  if (relayConnection) {
    relayConnection.close(1000, 'User disconnected');
    relayConnection = null;
  }
  if (sseConnection) {
    sseConnection.close();
    sseConnection = null;
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
    // User-initiated Connect is interactive: the worker will auto-
    // bootstrap missing auth (pair for local)
    // rather than requiring the popup to pre-check credentials.
    connect({ interactive: true })
      .then(async () => {
        // Guard: skip if the user paused/disconnected while the connect
        // was in-flight — their pause intent takes precedence.
        if (shouldConnect) {
          await setAutoConnect(true);
        }
        sendResponseFn({ ok: true });
      })
      .catch(async (err) => {
        // Reset shouldConnect so a subsequent storage change or
        // bootstrap doesn't silently retry a doomed connect. The user
        // will press Connect again after signing in / pairing.
        shouldConnect = false;
        // Undo the popup's eager autoConnect write — a failed connect
        // must not leave the flag set, otherwise the next bootstrap
        // would retry a doomed connect.
        await setAutoConnect(false);
        const serializedError = serializeWorkerError(err);
        const errorMessage = serializedError.error;
        // Classify the failure: auth-related errors (MissingTokenError)
        // surface as `auth_required`; everything else is a generic `error`.
        if (err instanceof MissingTokenError) {
          setConnectionHealth('auth_required', {
            lastErrorMessage: errorMessage,
          });
        } else {
          setConnectionHealth('error', {
            lastErrorMessage: errorMessage,
          });
        }
        sendResponseFn({ ok: false, ...serializedError });
      });
    return true; // async
  }
  // `pause` is the canonical user-level stop action: it clears the
  // sticky auto-connect flag so the extension does not reconnect on
  // the next startup, then tears down the relay connection.
  // `disconnect` is kept as a backward-compatible alias during rollout
  // — both actions perform identical state transitions.
  if (message.type === 'pause' || message.type === 'disconnect') {
    shouldConnect = false;
    setConnectionHealth('paused');
    // Await the storage write so MV3 can't terminate the worker before
    // the autoConnect flag is persisted to false.
    setAutoConnect(false)
      .then(() => {
        disconnect();
        sendResponseFn({ ok: true });
      })
      .catch(() => {
        // Even if the storage write fails, still disconnect and respond.
        disconnect();
        sendResponseFn({ ok: true });
      });
    return true; // async
  }
  if (message.type === 'get_status') {
    sendResponseFn({
      connected: isAnyConnectionOpen(),
      authProfile: currentAuthProfile,
      health: connectionHealth,
      healthDetail: connectionHealthDetail,
    });
    return false;
  }
  if (message.type === 'self-hosted-pair') {
    // Bootstrap a capability token by POSTing directly to the gateway's
    // /v1/browser-extension-pair endpoint.
    (async () => {
      const gatewayUrl = await getStoredGatewayUrl();
      const stored = await bootstrapDirectPairToken(gatewayUrl);

      if (shouldConnect || relayConnection) {
        setConnectionHealth('reconnecting');
        disconnect();
        await connect({ interactive: false });
      }

      return stored;
    })()
      .then((stored: StoredLocalToken) => sendResponseFn({ ok: true, token: stored }))
      .catch((err) => sendResponseFn({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    return true; // async
  }
  if (message.type === 'gateway-url-get') {
    getStoredGatewayUrl()
      .then((gatewayUrl) => sendResponseFn({ ok: true, gatewayUrl }))
      .catch((err) =>
        sendResponseFn({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    return true; // async
  }
  if (message.type === 'gateway-url-set') {
    const url =
      typeof message.gatewayUrl === 'string' ? message.gatewayUrl.trim() : null;
    if (!url) {
      sendResponseFn({ ok: false, error: 'gatewayUrl is required' });
      return false;
    }
    (async () => {
      await setStoredGatewayUrl(url);

      // When connected, tear down and reconnect to the new gateway.
      if (shouldConnect && (relayConnection || sseConnection)) {
        disconnect();
        try {
          await connect({ interactive: true });
        } catch (err) {
          shouldConnect = false;
          const errorMessage =
            err instanceof Error ? err.message : String(err);
          console.warn(
            `[vellum-relay] Gateway URL switch left disconnected: ${errorMessage}`,
          );
          if (err instanceof MissingTokenError) {
            setConnectionHealth('auth_required', {
              lastErrorMessage: errorMessage,
            });
          } else {
            setConnectionHealth('error', {
              lastErrorMessage: errorMessage,
            });
          }
        }
      }

      sendResponseFn({ ok: true, gatewayUrl: url });
    })().catch((err) =>
      sendResponseFn({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return true; // async
  }
  if (message.type === 'environment-get') {
    // Returns the effective environment and its components so the popup
    // can display which environment is active and whether an override is
    // in effect.
    Promise.all([getEffectiveEnvironment(), getOverrideEnvironment()])
      .then(([effectiveEnvironment, overrideEnvironment]) => {
        sendResponseFn({
          ok: true,
          effectiveEnvironment,
          overrideEnvironment,
          buildDefaultEnvironment: resolveBuildDefaultEnvironment(),
        });
      })
      .catch((err) =>
        sendResponseFn({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    return true; // async
  }
  if (message.type === 'environment-set') {
    // Validates and persists an environment override. Pass
    // `environment: null` to clear the override and revert to the
    // build default.
    //
    // NOTE: This handler only persists the override and invalidates
    // stale auth tokens — it does NOT disconnect or reconnect the
    // active relay connection. The caller (popup) is responsible for
    // orchestrating disconnect/reconnect after receiving the response
    // if it wants the new environment to take effect immediately.
    // `getCloudUrls()` is called fresh on each connect/reconnect cycle,
    // so the persisted override is picked up automatically on the next
    // connection without any additional plumbing.
    const rawEnv = message.environment;
    if (rawEnv === null || rawEnv === undefined) {
      // Clear override
      (async () => {
        const previousEnv = await getEffectiveEnvironment();
        await setOverrideEnvironment(null);
        const effectiveEnvironment = await getEffectiveEnvironment();
        // Invalidate cached auth tokens when the effective environment
        // actually changes so stale credentials from the previous
        // environment are not reused on the next connect cycle.
        if (effectiveEnvironment !== previousEnv) {
          await invalidateAuthTokens();
        }
        sendResponseFn({
          ok: true,
          effectiveEnvironment,
          overrideEnvironment: null,
          buildDefaultEnvironment: resolveBuildDefaultEnvironment(),
        });
      })().catch((err) =>
        sendResponseFn({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
      return true; // async
    }
    if (typeof rawEnv !== 'string') {
      sendResponseFn({ ok: false, error: 'environment must be a string or null' });
      return false;
    }
    const parsed = parseExtensionEnvironment(rawEnv);
    if (!parsed) {
      sendResponseFn({
        ok: false,
        error: `Invalid environment: "${rawEnv}". Must be one of: local, dev, staging, production`,
      });
      return false;
    }
    (async () => {
      const previousEnv = await getEffectiveEnvironment();
      await setOverrideEnvironment(parsed);
      const effectiveEnvironment = await getEffectiveEnvironment();
      if (effectiveEnvironment !== previousEnv) {
        await invalidateAuthTokens();
      }
      sendResponseFn({
        ok: true,
        effectiveEnvironment,
        overrideEnvironment: parsed,
        buildDefaultEnvironment: resolveBuildDefaultEnvironment(),
      });
    })().catch((err) =>
      sendResponseFn({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return true; // async
  }

  // ── Onboarding / session messages ─────────────────────────────────

  if (message.type === 'get-session') {
    (async () => {
      const session = await getStoredSession();
      const selectedAssistant = await getSelectedAssistant();
      let mode = await getStoredUserMode();

      // Backward compatibility: existing users who connected before
      // the onboarding flow was added will have autoConnect=true but
      // no userMode. Infer self-hosted so they skip the welcome screen.
      if (!mode) {
        const autoConnectResult = await chrome.storage.local.get(AUTO_CONNECT_KEY);
        if (autoConnectResult[AUTO_CONNECT_KEY] === true) {
          mode = 'self-hosted';
          await setStoredUserMode('self-hosted');
        }
      }

      sendResponseFn({
        ok: true,
        mode,
        session: session ? { email: session.email } : null,
        selectedAssistant,
      });
    })().catch(() => sendResponseFn({ ok: false, mode: null }));
    return true; // async
  }

  if (message.type === 'set-mode') {
    (async () => {
      const newMode = message.mode as 'self-hosted' | 'cloud';
      await setStoredUserMode(newMode);
      sendResponseFn({ ok: true });
    })().catch((err) =>
      sendResponseFn({ ok: false, error: err instanceof Error ? err.message : String(err) }),
    );
    return true; // async
  }

  if (message.type === 'cloud-login') {
    (async () => {
      const env = await getEffectiveEnvironment();
      const session = await startCloudLogin(env);
      let assistants: Array<{ id: string; name: string }> = [];
      let assistantsError: string | undefined;
      try {
        assistants = await fetchAssistants(env);
      } catch (err) {
        assistantsError = err instanceof Error ? err.message : String(err);
      }
      await setStoredUserMode('cloud');
      sendResponseFn({
        ok: true,
        session: { email: session.email },
        assistants,
        assistantsError,
      });
    })().catch((err) =>
      sendResponseFn({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return true; // async
  }

  if (message.type === 'cloud-logout') {
    (async () => {
      shouldConnect = false;
      disconnect();
      setConnectionHealth('paused');
      await setAutoConnect(false);
      await clearSession();
      await clearSelectedAssistant();
      await clearStoredUserMode();
      sendResponseFn({ ok: true });
    })().catch(() => sendResponseFn({ ok: true }));
    return true; // async
  }

  if (message.type === 'select-assistant') {
    (async () => {
      const assistantId = message.assistantId as string;
      const assistantName = message.assistantName as string;
      await storeSelectedAssistant({ id: assistantId, name: assistantName });
      sendResponseFn({ ok: true });
    })().catch((err) =>
      sendResponseFn({ ok: false, error: err instanceof Error ? err.message : String(err) }),
    );
    return true; // async
  }

  // Unknown message type — let Chrome close the port naturally.
  return false;
});

// Auto-connect on service worker start if previously connected.
// Only fires when the sticky `autoConnect` flag is `true` (set by a
// prior successful user-initiated Connect). Bootstrap uses a non-
// interactive connect so it never pops up auth UIs — if credentials
// are missing the user will see the disconnected state in the popup
// and can trigger an interactive connect manually.
async function bootstrap(): Promise<void> {
  const result = await chrome.storage.local.get(AUTO_CONNECT_KEY);
  if (result[AUTO_CONNECT_KEY] !== true) return;
  shouldConnect = true;
  try {
    await connect({ interactive: false });
  } catch (err) {
    // A missing token at auto-connect time is not a hard failure —
    // the user will see the disconnected state in the popup and can
    // sign in / pair to try again. Persist the error detail exactly
    // once so the popup can surface it, then stop retrying.
    shouldConnect = false;
    if (err instanceof MissingTokenError) {
      console.warn(`[vellum-relay] Skipping auto-connect: ${err.message}`);
      setConnectionHealth('auth_required', {
        lastErrorMessage: err.message,
      });
      void setRelayAuthError({
        message: err.message,
        mode: 'self-hosted',
        at: Date.now(),
      });
      return;
    }
    // Non-token errors (e.g. native host not installed) are not
    // recoverable at auto-connect time. Reset state and log so the
    // popup shows disconnected rather than crashing the worker with
    // an unhandled rejection.
    const detail = err instanceof Error ? err.message : String(err);
    console.warn(`[vellum-relay] Auto-connect failed: ${detail}`);
    setConnectionHealth('error', {
      lastErrorMessage: detail,
    });
    void setRelayAuthError({
      message: detail,
      mode: 'self-hosted',
      at: Date.now(),
    });
  }
}

bootstrap();
