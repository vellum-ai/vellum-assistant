/**
 * Chrome MV3 service worker — browser-relay bridge.
 *
 * Connects to the local assistant's browser-relay endpoint
 * (`ws://127.0.0.1:<port>/v1/browser-relay`) for self-hosted assistants.
 * Cloud-managed (platform-hosted) assistants are not yet supported by
 * the extension — see ATL-239–243 for the SSE+WorkOS transport work.
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
  parseExtensionEnvironment,
  resolveBuildDefaultEnvironment,
} from './extension-environment.js';
import {
  listAssistants,
  type AssistantDescriptor,
  type AssistantCatalog,
} from './native-host-assistants.js';
import {
  resolveAuthProfile,
  type AssistantAuthProfile,
} from './assistant-auth-profile.js';
import {
  bootstrapLocalToken,
  getStoredLocalToken,

  validateLocalToken,
  isLocalTokenStale,
  LEGACY_LOCAL_STORAGE_KEY,
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

// ── Environment resolution ──────────────────────────────────────────
//
// The effective environment drives URL resolution. Precedence:
//   1. Popup override persisted in chrome.storage.local
//   2. Build-time default injected via `--define` at bundle time
//   3. Fallback to 'dev' (see resolveBuildDefaultEnvironment)
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
 * Remove all stored auth tokens for every assistant
 * and clear the selected assistant ID. Called when the effective
 * environment changes so stale tokens minted against the previous
 * environment are not reused on the next connect. The selected assistant
 * ID is cleared because it references an assistant from the old
 * environment's catalog — the next `resolveSelectedAssistant` call will
 * auto-select from the new environment's catalog.
 *
 * Token storage keys use a well-known prefix
 * (`vellum.localCapabilityToken`) — we enumerate all storage keys and
 * remove those matching the prefix.
 */
async function invalidateAuthTokens(): Promise<void> {
  const all = await chrome.storage.local.get(null);
  const keysToRemove = Object.keys(all).filter(
    (k) => k.startsWith('vellum.localCapabilityToken'),
  );
  // Also clear the selected assistant — it belongs to the old
  // environment's catalog and would cause the connect flow to either
  // pick the wrong assistant or fall through to the legacy path.
  keysToRemove.push(SELECTED_ASSISTANT_ID_KEY);
  await chrome.storage.local.remove(keysToRemove);
}

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
  mode: 'self-hosted';
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

// ── Assistant selection ─────────────────────────────────────────────
//
// The worker owns the selected-assistant lifecycle. The popup reads the
// current catalog and selection via `assistants-get` and persists a new
// choice via `assistant-select`. Selection is stored in
// `chrome.storage.local` so it survives service-worker teardown.
//
// Selection resolution rules (applied by `resolveSelectedAssistant`):
//   1. If exactly one assistant exists, auto-select it.
//   2. If multiple assistants exist and the stored selection is still
//      valid (present in the catalog), keep it.
//   3. If multiple assistants exist and the stored selection is
//      missing/invalid, default to the first assistant entry.
//   4. If no assistants exist, return null (empty-state).

const SELECTED_ASSISTANT_ID_KEY = 'vellum.selectedAssistantId';

/**
 * Read the persisted selected-assistant ID from chrome.storage.local.
 * Returns `null` when nothing is stored or the value is not a string.
 */
async function loadSelectedAssistantId(): Promise<string | null> {
  const result = await chrome.storage.local.get(SELECTED_ASSISTANT_ID_KEY);
  const stored = result[SELECTED_ASSISTANT_ID_KEY];
  return typeof stored === 'string' && stored.length > 0 ? stored : null;
}

/**
 * Persist a selected-assistant ID in chrome.storage.local.
 */
async function saveSelectedAssistantId(assistantId: string): Promise<void> {
  await chrome.storage.local.set({ [SELECTED_ASSISTANT_ID_KEY]: assistantId });
}

/**
 * Apply the selection resolution rules described above.
 *
 * Returns the resolved assistant descriptor or `null` when the catalog
 * is empty. Also persists the resolved ID when it changes (auto-select
 * or invalid-stored-selection recovery) so subsequent reads don't
 * re-resolve.
 */
async function resolveSelectedAssistant(
  catalog: AssistantCatalog,
): Promise<AssistantDescriptor | null> {
  const { assistants } = catalog;
  if (assistants.length === 0) return null;

  // Rule 1: exactly one assistant — auto-select.
  if (assistants.length === 1) {
    await saveSelectedAssistantId(assistants[0]!.assistantId);
    return assistants[0]!;
  }

  // Rule 2 / 3: multiple assistants — check stored selection.
  const storedId = await loadSelectedAssistantId();
  if (storedId) {
    const match = assistants.find((a) => a.assistantId === storedId);
    if (match) return match;
  }

  // Stored selection is missing or invalid — default to first entry.
  const first = assistants[0]!;
  await saveSelectedAssistantId(first.assistantId);
  return first;
}

/**
 * Convenience: fetch the catalog and resolve the selected assistant in
 * one call. Used by the `assistants-get` message handler and by the
 * connect flow.
 */
async function getAssistantCatalogAndSelection(): Promise<{
  assistants: AssistantDescriptor[];
  selected: AssistantDescriptor | null;
  authProfile: AssistantAuthProfile | null;
}> {
  const environment = await getEffectiveEnvironment();
  const catalog = await listAssistants({ environment });
  const selected = await resolveSelectedAssistant(catalog);
  const authProfile = selected
    ? resolveAuthProfile({ cloud: selected.cloud, runtimeUrl: selected.runtimeUrl })
    : null;
  return { assistants: catalog.assistants, selected, authProfile };
}

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
// The connect path is driven entirely by the selected assistant's auth
// profile (`local-pair` | `unsupported`) derived from
// the selected assistant's lockfile topology. This determines both the
// relay target and the token source.

/**
 * The auth profile of the currently connected (or last-attempted)
 * assistant. Updated on every `connect()` call. Used by the onClose
 * handler to determine the error mode label.
 */
let currentAuthProfile: AssistantAuthProfile | null = null;

let relayConnection: RelayConnection | null = null;
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

  // Fallback path: no active connection (e.g. a stale result arriving
  // after `disconnect()`).
  // Self-hosted fallback: POST directly to the local assistant using the
  // capability token from the native-messaging pair flow. If no paired
  // token is available the result is dropped. When no assistant is
  // selected, fall back to the legacy unscoped token key.
  const selectedId = await loadSelectedAssistantId();
  const local = selectedId
    ? await getStoredLocalToken(selectedId)
    : await getLegacyLocalToken();
  if (local) {
    const fallbackPort = local.assistantPort ?? DEFAULT_RELAY_PORT;
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

/**
 * Read a local capability token from the legacy unscoped storage key
 * (`vellum.localCapabilityToken`). Used as a backward-compatible
 * fallback when no assistant is selected.
 */
async function getLegacyLocalToken(): Promise<StoredLocalToken | null> {
  const result = await chrome.storage.local.get(LEGACY_LOCAL_STORAGE_KEY);
  return validateLocalToken(result[LEGACY_LOCAL_STORAGE_KEY]);
}

// ── Relay connection lifecycle ──────────────────────────────────────

/**
 * Build the {@link RelayMode} for a given assistant descriptor. The
 * auth profile derived from the assistant's lockfile topology drives
 * which token to read and which base URL to target.
 *
 * For `local-pair`:
 *   - Read the assistant-scoped local capability token.
 *   - Target the local assistant runtime at `http://127.0.0.1:<port>`.
 *
 * When no assistant is selected (legacy fallback), the behavior mirrors
 * the pre-assistant-selection logic: read from legacy unscoped token
 * keys and use default endpoints.
 */
async function buildRelayModeForAssistant(
  assistant: AssistantDescriptor | null,
): Promise<RelayMode> {
  if (!assistant) {
    // No assistant selected — legacy fallback path.
    const local = await getLegacyLocalToken();
    if (local) {
      const port = local.assistantPort ?? DEFAULT_RELAY_PORT;
      return {
        kind: 'self-hosted',
        baseUrl: `http://127.0.0.1:${port}`,
        token: local.token,
      };
    }
    // No token at all — return a token-less self-hosted mode so the
    // caller can surface a missing-token error.
    const port = DEFAULT_RELAY_PORT;
    return {
      kind: 'self-hosted',
      baseUrl: `http://127.0.0.1:${port}`,
      token: null,
    };
  }

  const profile = resolveAuthProfile({
    cloud: assistant.cloud,
    runtimeUrl: assistant.runtimeUrl,
  });

  if (profile === 'local-pair') {
    let local = await getStoredLocalToken(assistant.assistantId);

    // Silent token recovery: when the stored token is missing, expired,
    // or stale (within the stale window), attempt a non-interactive
    // bootstrap before surfacing a missing-token error. This lets
    // returning local users with expired/stale pair tokens auto-recover
    // without a manual re-pair click in startup/reconnect flows.
    if (isLocalTokenStale(local)) {
      try {
        const environment = await getEffectiveEnvironment();
        local = await bootstrapLocalToken(assistant.assistantId, { environment });
      } catch (err) {
        // Non-recoverable native-host failures (missing host, forbidden
        // origin, pair endpoint failure) — leave the original `local`
        // value unchanged so a stale-but-not-expired token can still be
        // used. If the original was already null, nothing changes.
        const detail = err instanceof Error ? err.message : String(err);
        console.warn(
          `[vellum-relay] Silent local token refresh failed: ${detail}`,
        );
      }
    }

    if (local) {
      const port = local.assistantPort ?? assistant.daemonPort ?? DEFAULT_RELAY_PORT;
      return {
        kind: 'self-hosted',
        baseUrl: `http://127.0.0.1:${port}`,
        token: local.token,
      };
    }
    // No local token yet — return token-less mode for the error path.
    const port = assistant.daemonPort ?? DEFAULT_RELAY_PORT;
    return {
      kind: 'self-hosted',
      baseUrl: `http://127.0.0.1:${port}`,
      token: null,
    };
  }

  // profile === 'unsupported'
  // Return a token-less mode — the connect path will surface an
  // actionable error.
  return {
    kind: 'self-hosted',
    baseUrl: `http://127.0.0.1:${DEFAULT_RELAY_PORT}`,
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
      const selectedId = await loadSelectedAssistantId();
      let local = selectedId
        ? await getStoredLocalToken(selectedId)
        : await getLegacyLocalToken();

      // Silent token recovery on reconnect: when the stored local token
      // is stale/expired/missing, attempt a non-interactive bootstrap
      // before aborting. This mirrors the preflight recovery in
      // buildRelayModeForAssistant and lets auto-reconnect paths
      // silently refresh tokens without user interaction.
      if (isLocalTokenStale(local) && selectedId) {
        try {
          const environment = await getEffectiveEnvironment();
          local = await bootstrapLocalToken(selectedId, { environment });
        } catch (err) {
          // Leave original `local` value unchanged so a stale-but-not-expired
          // token can still be used on reconnect.
          const detail = err instanceof Error ? err.message : String(err);
          console.warn(
            `[vellum-relay] Silent local token refresh on reconnect failed: ${detail}`,
          );
        }
      }

      if (local?.token) {
        return { kind: 'refreshed', token: local.token };
      }
      return {
        kind: 'abort',
        error:
          "Self-hosted relay token missing or expired. Use 'Re-pair' in Advanced, then turn Connection on again.",
      };
    },
  });
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
  if (profile === 'local-pair') {
    return "Automatic local pairing failed \u2014 use 'Re-pair' in Advanced, then turn Connection on again";
  }
  if (profile === 'vellum-cloud') {
    return 'Vellum cloud auth is not yet supported by the extension. Please update or use a local assistant.';
  }
  if (profile === 'unsupported') {
    return 'This assistant uses an unsupported topology. Please update the Vellum extension.';
  }
  // No assistant selected
  return 'Select an assistant before connecting';
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
 *   credentials are missing or stale. For `local-pair` this runs
 *   `bootstrapLocalToken`.
 * - `interactive: false` — the worker will NOT launch an interactive
 *   flow. Missing credentials produce a {@link MissingTokenError}.
 */
interface ConnectOptions {
  interactive: boolean;
}

/**
 * Resolve credentials for the selected assistant before the socket
 * opens. This is the single authority for whether auth is satisfied —
 * the popup no longer needs to pre-check pairing/sign-in state.
 *
 * For `local-pair`:
 *   - If the assistant-scoped local token is present and unexpired,
 *     the existing relay mode is returned as-is.
 *   - If the token is missing/expired and `interactive=true`, runs
 *     `bootstrapLocalToken({ assistantId })` and rebuilds the mode.
 *   - If the token is missing/expired and `interactive=false`, throws
 *     a {@link MissingTokenError}.
 *
 * Returns the (possibly refreshed) {@link RelayMode} ready for socket
 * open.
 */
async function connectPreflight(
  assistant: AssistantDescriptor | null,
  authProfile: AssistantAuthProfile | null,
  mode: RelayMode,
  options: ConnectOptions,
): Promise<RelayMode> {
  // Token already present — nothing to do.
  if (mode.token) {
    return mode;
  }

  if (authProfile === 'local-pair') {
    if (!options.interactive) {
      throw new MissingTokenError(missingTokenMessage('local-pair'));
    }
    // Interactive: auto-bootstrap the local capability token.
    const assistantId = assistant?.assistantId ?? null;
    const environment = await getEffectiveEnvironment();
    const stored = await bootstrapLocalToken(assistantId, { environment });
    const port = stored.assistantPort ?? assistant?.daemonPort ?? DEFAULT_RELAY_PORT;
    return {
      kind: 'self-hosted',
      baseUrl: `http://127.0.0.1:${port}`,
      token: stored.token,
    };
  }

  // Unsupported or no assistant selected — preflight can't help.
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

async function doConnect(options: ConnectOptions): Promise<void> {
  if (relayConnection && relayConnection.isOpen()) return;
  setConnectionHealth('connecting');

  // A fresh connect attempt supersedes any previously persisted
  // auth-error — the user either just signed back in or is explicitly
  // retrying, and we want the popup to stop nagging.
  await clearRelayAuthError();

  // Resolve the selected assistant and derive the auth profile + relay
  // mode. This replaces the old `loadRelayMode()` call — the assistant's
  // lockfile topology is now the single source of truth for which
  // transport and token to use.
  const { selected, authProfile } = await getAssistantCatalogAndSelection();
  currentAuthProfile = authProfile;

  // Guard: unsupported topology produces an actionable error.
  if (authProfile === 'unsupported') {
    const msg = missingTokenMessage('unsupported');
    console.warn(`[vellum-relay] ${msg}`);
    throw new MissingTokenError(msg);
  }

  const rawMode = await buildRelayModeForAssistant(selected);
  // Run the preflight to resolve/bootstrap credentials. When
  // interactive=true the preflight auto-pairs or auto-signs-in;
  // when interactive=false it either refreshes non-interactively or
  // throws MissingTokenError.
  const mode = await connectPreflight(selected, authProfile, rawMode, options);
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
      connected: relayConnection !== null && relayConnection.isOpen(),
      authProfile: currentAuthProfile,
      health: connectionHealth,
      healthDetail: connectionHealthDetail,
    });
    return false;
  }
  if (message.type === 'self-hosted-pair') {
    // Run the native-messaging
    // bootstrap in the service worker so the popup closing mid-pair
    // can't tear down the awaited promise before the token is persisted.
    // chrome.runtime.connectNative also requires the "nativeMessaging"
    // permission, which is declared in manifest.json.
    //
    // When no assistant is selected (legacy popup flow), fall back to
    // bootstrapping without an assistantId — the token is persisted to
    // the legacy unscoped key so existing connect behavior is preserved.
    const assistantId =
      typeof message.assistantId === 'string' ? message.assistantId : null;
    (assistantId
      ? Promise.resolve(assistantId)
      : loadSelectedAssistantId()
    )
      .then(async (resolvedId) => {
        const environment = await getEffectiveEnvironment();
        const stored = await bootstrapLocalToken(resolvedId, { environment });

        // If the relay is intended to be connected, rotate the live socket
        // so the fresh paired token is applied immediately. Without this,
        // a stale open socket (bound under a previous guardian/token) can
        // remain in memory and keep failing host_browser routing until the
        // user manually toggles Connection off/on.
        if (shouldConnect || relayConnection) {
          setConnectionHealth('reconnecting');
          disconnect();
          await connect({ interactive: false });
        }

        return stored;
      })
      .then((stored: StoredLocalToken) => sendResponseFn({ ok: true, token: stored }))
      .catch((err) => sendResponseFn({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    return true; // async
  }
  if (message.type === 'assistants-get') {
    // Returns the full assistant catalog, the resolved selected
    // assistant, and the auth profile for the selected assistant.
    // The popup uses this to render the assistant selector and decide
    // which auth flow to present.
    getAssistantCatalogAndSelection()
      .then(({ assistants, selected, authProfile }) =>
        sendResponseFn({
          ok: true,
          assistants,
          selected,
          authProfile,
        }),
      )
      .catch((err) =>
        sendResponseFn({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    return true; // async
  }
  if (message.type === 'assistant-select') {
    // Persists a specific assistant ID and returns the resolved
    // descriptor. The popup calls this when the user picks a different
    // assistant from the dropdown.
    const assistantId =
      typeof message.assistantId === 'string' ? message.assistantId : null;
    if (!assistantId) {
      sendResponseFn({ ok: false, error: 'assistantId is required' });
      return false;
    }
    // Fetch a fresh catalog so the selected ID is validated against the
    // current lockfile state — a stale ID from a previous session
    // should not be persisted.
    getEffectiveEnvironment()
      .then((environment) => listAssistants({ environment }))
      .then(async (catalog) => {
        const match = catalog.assistants.find(
          (a) => a.assistantId === assistantId,
        );
        if (!match) {
          sendResponseFn({
            ok: false,
            error: `Assistant "${assistantId}" not found in the current catalog`,
          });
          return;
        }
        await saveSelectedAssistantId(assistantId);
        const authProfile = resolveAuthProfile({
          cloud: match.cloud,
          runtimeUrl: match.runtimeUrl,
        });

        // When connected and the user switches assistants, tear down
        // the current connection so the next connect targets the new
        // assistant's relay endpoint and token.
        if (shouldConnect && relayConnection) {
          disconnect();
          // Attempt a reconnect to the newly selected assistant.
          // Interactive since the user is actively switching.
          // Errors are non-fatal — the user can manually reconnect.
          try {
            await connect({ interactive: true });
          } catch (err) {
            // The assistant selection was already persisted and the old
            // relay disconnected, so the switch itself succeeded regardless
            // of whether the reconnect worked. MissingTokenError means no
            // credentials at all; other errors (e.g. user cancels the
            // auth flow or the native host is not installed) are
            // transient. In both cases, log and continue — the user can
            // manually reconnect via the Connect button.
            shouldConnect = false;
            const errorMessage =
              err instanceof Error ? err.message : String(err);
            console.warn(
              `[vellum-relay] Assistant switch left disconnected: ${errorMessage}`,
            );
            // Transition health so the popup reflects the actual state
            // instead of remaining stuck at 'connecting'.
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

        sendResponseFn({
          ok: true,
          selected: match,
          authProfile,
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
