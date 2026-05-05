/**
 * Chrome MV3 service worker — SSE bridge.
 *
 * Connects to the SSE `/v1/events` endpoint for both self-hosted and
 * vellum-cloud assistants. Self-hosted hits the local gateway directly
 * (loopback peers are trusted without a JWT); cloud mode hits the
 * platform API with session credentials.
 *
 * The worker owns the full connect lifecycle:
 *   - **One-click Connect**: The popup sends `connect` and the worker
 *     opens an SSE connection using stored config.
 *   - **Auto-connect on reopen**: After a successful connect, the
 *     `autoConnect` storage flag is set. On service-worker startup
 *     the `bootstrap()` function reads this flag and reconnects.
 *   - **Pause**: The `pause` message clears the `autoConnect` flag
 *     and tears down the connection.
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
} from "./extension-environment.js";
import { type AssistantAuthProfile } from "./assistant-auth-profile.js";
import {
  createHostBrowserDispatcher,
  type HostBrowserDispatcher,
  type HostBrowserEventEnvelope,
  type HostBrowserRequestEnvelope,
  type HostBrowserCancelEnvelope,
  type HostBrowserResultEnvelope,
  type HostBrowserSessionInvalidatedEnvelope,
} from "./host-browser-dispatcher.js";
import { SseConnection, type SseMode } from "./sse-connection.js";
import { fetchAssistants, getCsrfToken } from "./cloud-api.js";
import { appendEvent, clearEventLog, getEventLog, getOperations, getOperationById, recordRequest, recordResponse } from "./event-log.js";
import {
  startCloudLogin,
  getStoredSession,
  clearSession,
  getSelectedAssistant,
  storeSelectedAssistant,
  clearSelectedAssistant,
} from "./cloud-auth.js";

// ── Environment resolution ──────────────────────────────────────────
//
// The effective environment drives URL resolution. Precedence:
//   1. Popup override persisted in chrome.storage.local
//   2. Build-time default injected via `--define` at bundle time
//   3. Fallback to 'production' (see resolveBuildDefaultEnvironment)
//
// The popup can read and write the override via `environment-get` and
// `environment-set` worker messages without requiring an extension reload.

// ── Self-hosted gateway URL storage ──────────────────────────────────
// Inlined from the removed self-hosted-auth module. The gateway URL is
// stored in chrome.storage.local so the popup settings page can read/write it.
const GATEWAY_URL_STORAGE_KEY = "vellum.selfHostedGatewayUrl";
const DEFAULT_GATEWAY_URL = "http://127.0.0.1:7830";

async function getStoredGatewayUrl(): Promise<string> {
  const result = await chrome.storage.local.get(GATEWAY_URL_STORAGE_KEY);
  const stored = result[GATEWAY_URL_STORAGE_KEY];
  return typeof stored === "string" && stored.length > 0
    ? stored
    : DEFAULT_GATEWAY_URL;
}

async function setStoredGatewayUrl(url: string): Promise<void> {
  await chrome.storage.local.set({ [GATEWAY_URL_STORAGE_KEY]: url });
}
// ─────────────────────────────────────────────────────────────────────

const ENVIRONMENT_OVERRIDE_KEY = "vellum.environmentOverride";

/**
 * Resolve the effective environment by checking for a popup-persisted
 * override first, then falling back to the build-time default.
 */
async function getEffectiveEnvironment(): Promise<ExtensionEnvironment> {
  const result = await chrome.storage.local.get(ENVIRONMENT_OVERRIDE_KEY);
  const override = result[ENVIRONMENT_OVERRIDE_KEY];
  if (typeof override === "string") {
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
  if (typeof override === "string") {
    return parseExtensionEnvironment(override);
  }
  return null;
}

/**
 * Persist an environment override. Pass `null` to clear.
 */
async function setOverrideEnvironment(
  env: ExtensionEnvironment | null,
): Promise<void> {
  if (env === null) {
    await chrome.storage.local.remove(ENVIRONMENT_OVERRIDE_KEY);
  } else {
    await chrome.storage.local.set({ [ENVIRONMENT_OVERRIDE_KEY]: env });
  }
}

/**
 * Remove legacy capability-token storage keys left over from older
 * versions that used the (now-deleted) /v1/pair flow. Called when the
 * environment changes so stale entries don't accumulate.
 */
async function invalidateAuthTokens(): Promise<void> {
  const all = await chrome.storage.local.get(null);
  const keysToRemove = Object.keys(all).filter((k) =>
    k.startsWith("vellum.localCapabilityToken"),
  );
  if (keysToRemove.length > 0) {
    await chrome.storage.local.remove(keysToRemove);
  }
}

// ── Environment-aware toolbar icon ─────────────────────────────────

/**
 * Update the toolbar icon to match the current environment.
 *
 * Each environment has its own set of pre-generated icon PNGs under
 * `icons/<env>/`. Production is green, staging yellow, dev pink,
 * local blue — matching the desktop app's environment tinting.
 */
async function updateExtensionIcon(env: ExtensionEnvironment): Promise<void> {
  try {
    await chrome.action.setIcon({
      path: {
        "16": `icons/${env}/icon16.png`,
        "48": `icons/${env}/icon48.png`,
        "128": `icons/${env}/icon128.png`,
      },
    });
  } catch {
    // Best-effort — `chrome.action` may be unavailable in tests or
    // during early service-worker initialization.
  }
}

// Storage key that controls auto-connect on service-worker startup.
// Set to `true` after a successful user-initiated connect, cleared to
// `false` by the `pause` action so the extension stays quiet until
// the user explicitly reconnects.
const AUTO_CONNECT_KEY = "autoConnect";

// Storage key used to surface the most recent auth-related relay error
// to the popup. The popup reads this on open and shows it next to the
// sign-in button. Cleared on a successful connect so stale errors
// don't linger after the user re-signs in.
const RELAY_AUTH_ERROR_KEY = "vellum.relayAuthError";

interface RelayAuthError {
  message: string;
  mode: "self-hosted" | "vellum-cloud";
  at: number;
  debugDetails?: string;
}

async function setRelayAuthError(error: RelayAuthError): Promise<void> {
  try {
    await chrome.storage.local.set({ [RELAY_AUTH_ERROR_KEY]: error });
  } catch (err) {
    console.warn("[vellum-relay] Failed to persist relay auth error", err);
  }
}

async function clearRelayAuthError(): Promise<void> {
  try {
    await chrome.storage.local.remove(RELAY_AUTH_ERROR_KEY);
  } catch (err) {
    console.warn("[vellum-relay] Failed to clear relay auth error", err);
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
    console.warn("[vellum-relay] Failed to persist autoConnect flag", err);
  }
}

// ── Self-hosted gateway URL ──────────────────────────────────────────
//
// For self-hosted assistants the user provides a gateway URL (defaulting
// to http://127.0.0.1:7830). The popup reads/writes this via
// `gateway-url-get` and `gateway-url-set` messages. The connect flow
// uses it to open an SSE connection to the gateway's `/v1/events`.

// ── Connection health state ──────────────────────────────────────────
//
// Explicit state machine for the connection lifecycle. The popup
// consumes this via `get_status` instead of inferring state from the
// `connected` boolean and ad-hoc error fields.
//
// States:
//   - `paused`       — user explicitly paused; autoConnect is false.
//   - `connecting`    — initial connect attempt in progress.
//   - `connected`     — SSE connection is open.
//   - `reconnecting`  — connection dropped unexpectedly; reconnect in progress.
//   - `auth_required` — credentials are missing/expired and non-interactive
//                       refresh failed. User must sign in.
//   - `error`         — unrecoverable non-auth error (e.g. native host
//                       not installed, unsupported topology).

/**
 * Structured connection health state exposed to the popup via
 * `get_status`. Transitions are driven by the connect, reconnect,
 * close, and pause actions in the worker.
 */
export type ConnectionHealthState =
  | "paused"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "auth_required"
  | "assistant_gone"
  | "error";

/**
 * Detail fields attached to the current health state. Populated on
 * disconnect / error transitions and cleared on successful connect.
 */
export interface ConnectionHealthDetail {
  /** Close/error code from the last unexpected disconnect. */
  lastDisconnectCode?: number;
  /** Human-readable error message from the last failure. */
  lastErrorMessage?: string;
  /** Epoch ms of the most recent health state change. */
  lastChangeAt: number;
}

let connectionHealth: ConnectionHealthState = "paused";
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
  detail?: Partial<Omit<ConnectionHealthDetail, "lastChangeAt">>,
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
  if (state === "connected" || state === "paused" || state === "connecting") {
    delete connectionHealthDetail.lastDisconnectCode;
    delete connectionHealthDetail.lastErrorMessage;
  }
}

// ── Connection state ───────────────────────────────────────────────
//
// Both modes use SSE. `self-hosted` connects to the local gateway
// (loopback peers are trusted); `vellum-cloud` uses WorkOS session auth.

/**
 * The auth profile of the currently connected (or last-attempted)
 * assistant. Updated on every `connect()` call. Used by the onClose
 * handler to determine the error mode label.
 */
let currentAuthProfile: AssistantAuthProfile | null = null;

let sseConnection: SseConnection | null = null;
/** JWT obtained from POST /v1/pair during self-hosted connect. Used as Bearer on callback POSTs. */
let selfHostedPairToken: string | null = null;
let shouldConnect = false;

// ── Host browser dispatcher ────────────────────────────────────────
//
// `host_browser_request` / `host_browser_cancel` envelopes arriving on
// the SSE stream are routed into the CDP proxy dispatcher, which drives
// a chrome.debugger session and POSTs a result envelope back to the
// assistant's `/v1/host-browser-result` endpoint.

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
  const [activeTab] = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true,
  });
  if (activeTab?.id === undefined) {
    throw new Error("No active tab available to resolve host_browser target");
  }
  return { tabId: activeTab.id };
}

/**
 * POST a host_browser result back to the runtime via HTTP.
 *
 * Both self-hosted and cloud paths use SSE for inbound events.
 * Results go back via HTTP POST.
 *
 * Self-hosted: POST to `${gatewayUrl}/v1/host-browser-result` (loopback
 * peers are trusted without a JWT).
 *
 * Cloud: POST to `${runtimeUrl}/v1/assistants/${assistantId}/host-browser-result`
 * with session credentials and CSRF token.
 */
async function dispatchHostBrowserResult(
  result: HostBrowserResultEnvelope,
): Promise<void> {
  appendEvent("outbound", "host_browser_result", {
    summary: `${result.requestId.slice(0, 8)}${result.isError ? " (error)" : ""}`,
    isError: result.isError,
  });
  recordResponse(result.requestId, {
    isError: result.isError,
    responseContent: result.content,
  });

  if (sseConnection && sseConnection.isOpen()) {
    const mode = sseConnection.getMode();
    const baseUrl = mode.runtimeUrl.replace(/\/$/, "");

    const url =
      mode.kind === "self-hosted"
        ? `${baseUrl}/v1/host-browser-result`
        : `${baseUrl}/v1/assistants/${encodeURIComponent(mode.assistantId)}/host-browser-result`;

    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (mode.kind === "vellum-cloud") {
      if (mode.token) {
        headers["authorization"] = `Bearer ${mode.token}`;
      }
      const freshSession = await getStoredSession();
      if (freshSession?.sessionToken) {
        headers["X-Session-Token"] = freshSession.sessionToken;
      }
      if (mode.organizationId) {
        headers["Vellum-Organization-Id"] = mode.organizationId;
      }
      const csrfToken = await getCsrfToken(baseUrl);
      if (csrfToken) {
        headers["X-CSRFToken"] = csrfToken;
      }
    } else if (selfHostedPairToken) {
      headers["authorization"] = `Bearer ${selfHostedPairToken}`;
    }
    const resp = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(result),
      credentials: mode.kind === "vellum-cloud" ? "include" : "omit",
    });
    if (!resp.ok) {
      console.warn("[vellum] host-browser-result POST failed", resp.status);
    }
    return;
  }

  // Fallback for self-hosted: no active SSE connection but we can still
  // try POSTing directly to the gateway.
  const userMode = await getStoredUserMode();
  if (userMode !== "cloud") {
    const gatewayUrl = await getStoredGatewayUrl();
    try {
      const fallbackHeaders: Record<string, string> = { "content-type": "application/json" };
      if (selfHostedPairToken) {
        fallbackHeaders["authorization"] = `Bearer ${selfHostedPairToken}`;
      }
      const resp = await fetch(
        `${gatewayUrl.replace(/\/$/, "")}/v1/host-browser-result`,
        {
          method: "POST",
          headers: fallbackHeaders,
          body: JSON.stringify(result),
        },
      );
      if (!resp.ok) {
        console.warn("[vellum] host-browser-result fallback POST failed", resp.status);
      }
      return;
    } catch {
      // Network error — fall through to drop warning
    }
  }

  console.warn("[vellum] host_browser_result dropped: no active connection");
}

/**
 * Forward a `host_browser_event` envelope to the runtime via HTTP POST.
 *
 * CDP events are fire-and-forget — if the POST fails the envelope is
 * silently dropped. Chrome will emit many more events before the next
 * retry, so queueing during an outage would just pile up stale
 * notifications that the runtime cannot act on.
 */
function dispatchHostBrowserEvent(envelope: HostBrowserEventEnvelope): void {
  if (!sseConnection || !sseConnection.isOpen()) return;
  const mode = sseConnection.getMode();
  const baseUrl = mode.runtimeUrl.replace(/\/$/, "");
  const url =
    mode.kind === "self-hosted"
      ? `${baseUrl}/v1/host-browser-event`
      : `${baseUrl}/v1/assistants/${encodeURIComponent(mode.assistantId)}/host-browser-event`;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (mode.kind === "vellum-cloud") {
    if (mode.token) {
      headers["authorization"] = `Bearer ${mode.token}`;
    }
    if (mode.organizationId) {
      headers["Vellum-Organization-Id"] = mode.organizationId;
    }
    // Resolve CSRF token and session token concurrently — both are needed
    // for authenticated cross-site POSTs but neither is available synchronously.
    void Promise.all([getCsrfToken(baseUrl), getStoredSession()]).then(
      ([csrfToken, freshSession]) => {
        if (csrfToken) headers["X-CSRFToken"] = csrfToken;
        if (freshSession?.sessionToken) {
          headers["X-Session-Token"] = freshSession.sessionToken;
        }
        void fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(envelope),
          credentials: "include",
        }).catch(() => { /* fire and forget */ });
      },
    );
    return;
  } else if (selfHostedPairToken) {
    headers["authorization"] = `Bearer ${selfHostedPairToken}`;
  }
  void fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(envelope),
    credentials: "omit",
  }).catch(() => {
    /* fire and forget */
  });
}

/**
 * Forward a `host_browser_session_invalidated` envelope to the runtime.
 * Same fire-and-forget semantics as {@link dispatchHostBrowserEvent}.
 */
function dispatchHostBrowserSessionInvalidated(
  envelope: HostBrowserSessionInvalidatedEnvelope,
): void {
  if (!sseConnection || !sseConnection.isOpen()) return;
  const mode = sseConnection.getMode();
  const baseUrl = mode.runtimeUrl.replace(/\/$/, "");
  const url =
    mode.kind === "self-hosted"
      ? `${baseUrl}/v1/host-browser-session-invalidated`
      : `${baseUrl}/v1/assistants/${encodeURIComponent(mode.assistantId)}/host-browser-session-invalidated`;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (mode.kind === "vellum-cloud") {
    if (mode.token) {
      headers["authorization"] = `Bearer ${mode.token}`;
    }
    if (mode.organizationId) {
      headers["Vellum-Organization-Id"] = mode.organizationId;
    }
    void Promise.all([getCsrfToken(baseUrl), getStoredSession()]).then(
      ([csrfToken, freshSession]) => {
        if (csrfToken) headers["X-CSRFToken"] = csrfToken;
        if (freshSession?.sessionToken) {
          headers["X-Session-Token"] = freshSession.sessionToken;
        }
        void fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(envelope),
          credentials: "include",
        }).catch(() => { /* fire and forget */ });
      },
    );
    return;
  } else if (selfHostedPairToken) {
    headers["authorization"] = `Bearer ${selfHostedPairToken}`;
  }
  void fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(envelope),
    credentials: "omit",
  }).catch(() => {
    /* fire and forget */
  });
}

const hostBrowserDispatcher: HostBrowserDispatcher =
  createHostBrowserDispatcher({
    resolveTarget: resolveHostBrowserTarget,
    async createTab() {
      const [activeTab] = await chrome.tabs.query({
        active: true,
        lastFocusedWindow: true,
      });
      const newTab = await chrome.tabs.create({
        url: 'about:blank',
        active: true,
        windowId: activeTab?.windowId,
      });
      if (newTab.id === undefined) {
        throw new Error(
          'Failed to create a new tab for navigation (active tab was on a privileged URL)',
        );
      }
      return { tabId: newTab.id };
    },
    postResult: dispatchHostBrowserResult,
    forwardCdpEvent: dispatchHostBrowserEvent,
    forwardSessionInvalidated: dispatchHostBrowserSessionInvalidated,
  });

// ── Storage helpers ─────────────────────────────────────────────────

/** Storage key for the user's chosen connection mode (welcome screen). */
const USER_MODE_KEY = "vellum.userMode";

async function getStoredUserMode(): Promise<"self-hosted" | "cloud" | null> {
  try {
    const result = await chrome.storage.local.get(USER_MODE_KEY);
    const stored = result[USER_MODE_KEY];
    if (stored === "self-hosted" || stored === "cloud") return stored;
  } catch {
    /* best-effort */
  }
  return null;
}

async function setStoredUserMode(mode: "self-hosted" | "cloud"): Promise<void> {
  await chrome.storage.local.set({ [USER_MODE_KEY]: mode });
}

async function clearStoredUserMode(): Promise<void> {
  await chrome.storage.local.remove(USER_MODE_KEY);
}

// ── SSE connection lifecycle ─────────────────────────────────────────

/**
 * Wire an SseConnection up with the worker's message/open/close
 * callbacks. Works for both self-hosted and cloud modes.
 */
function createSseConnection(mode: SseMode): SseConnection {
  const label = mode.kind === "self-hosted" ? "self-hosted" : "cloud";
  return new SseConnection({
    mode,
    onOpen: () => {
      console.log(`[vellum-sse] Connected (${label})`);
      setConnectionHealth("connected");
      void clearRelayAuthError();
    },
    onMessage: (data) => {
      void handleSseMessage(data).catch((err) => {
        console.warn("[vellum-sse] handleSseMessage failed", err);
      });
    },
    onClose: (authError) => {
      console.log(
        `[vellum-sse] Disconnected${authError ? ` (auth: ${authError})` : ""}`,
      );
      if (authError) {
        shouldConnect = false;
        setConnectionHealth("auth_required", {
          lastErrorMessage: authError,
        });
        void setRelayAuthError({
          message: authError,
          mode: "vellum-cloud",
          at: Date.now(),
        });
        sseConnection = null;
      } else if (shouldConnect) {
        setConnectionHealth("reconnecting");
      }
    },
    onNotFound: () => {
      console.warn(
        "[vellum-sse] 404 — assistant not found, attempting recovery",
      );
      void handleAssistantGone();
    },
  });
}

/**
 * Recovery handler for when the selected assistant returns 404.
 *
 * Re-fetches the assistants list. If exactly one assistant exists and
 * it's different from the stored one, auto-switch and reconnect.
 * Otherwise, tear down and surface `assistant_gone` so the popup can
 * show the assistant picker.
 */
async function handleAssistantGone(): Promise<void> {
  teardownConnections();
  shouldConnect = false;

  let assistants: Array<{ id: string; name: string }> = [];
  try {
    const env = await getEffectiveEnvironment();
    assistants = await fetchAssistants(env);
  } catch (err) {
    console.error(
      "[vellum-sse] Failed to fetch assistants during 404 recovery",
      err,
    );
    setConnectionHealth("error", {
      lastErrorMessage: "Assistant not found and could not refresh the list.",
    });
    return;
  }

  const current = await getSelectedAssistant();

  if (assistants.length === 1 && assistants[0]!.id !== current?.id) {
    // A different sole assistant is available — auto-switch and reconnect.
    const only = assistants[0]!;
    console.log(
      `[vellum-sse] Auto-switching to sole assistant: ${only.name} (${only.id})`,
    );
    await storeSelectedAssistant({ id: only.id, name: only.name });
    shouldConnect = true;
    await connect({ interactive: false });
  } else {
    // Same assistant still 404ing, 0 assistants, or 2+ — user must pick.
    setConnectionHealth("assistant_gone", {
      lastErrorMessage: "The selected assistant no longer exists.",
    });
  }
}

/**
 * Handle an incoming SSE event payload from a vellum-cloud assistant.
 * The /events endpoint emits AssistantEvent envelopes; the
 * `host_browser_request` / `host_browser_cancel` events are dispatched
 * to the CDP proxy dispatcher.
 */
async function handleSseMessage(data: unknown): Promise<void> {
  if (!data || typeof data !== "object") return;

  // The /events SSE endpoint wraps messages in an AssistantEvent envelope:
  // { id, assistantId, message: { type, ... } }
  const envelope = data as { message?: unknown };
  const message = envelope.message;
  if (!message || typeof message !== "object") return;

  const typed = message as { type?: unknown };
  if (typeof typed.type !== "string") return;

  if (typed.type === "host_browser_request") {
    const req = message as HostBrowserRequestEnvelope;
    appendEvent("inbound", "host_browser_request", {
      summary: `${req.cdpMethod} (${req.requestId.slice(0, 8)})`,
    });
    recordRequest(req.requestId, req.cdpMethod, {
      cdpMethod: req.cdpMethod,
      cdpParams: req.cdpParams,
      cdpSessionId: req.cdpSessionId,
      conversationId: req.conversationId,
    });
    await hostBrowserDispatcher.handle(req);
    return;
  }
  if (typed.type === "host_browser_cancel") {
    const cancel = message as HostBrowserCancelEnvelope;
    appendEvent("inbound", "host_browser_cancel", {
      summary: cancel.requestId.slice(0, 8),
    });
    hostBrowserDispatcher.cancel(cancel);
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
    this.name = "MissingTokenError";
  }
}

//
// Threading an explicit `interactive` flag through the connect flow
// lets the serialization lock decide whether a new call should supersede
// an in-flight attempt (user-initiated Connect supersedes auto-connect).

interface ConnectOptions {
  interactive: boolean;
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

async function connect(
  options: ConnectOptions = { interactive: false },
): Promise<void> {
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
 * Helper: is the SSE connection currently open?
 */
function isAnyConnectionOpen(): boolean {
  return (
    sseConnection !== null && sseConnection.isOpen()
  );
}

async function doConnect(_options: ConnectOptions): Promise<void> {
  if (isAnyConnectionOpen()) return;
  setConnectionHealth("connecting");

  // A fresh connect attempt supersedes any previously persisted
  // auth-error — the user either just signed back in or is explicitly
  // retrying, and we want the popup to stop nagging.
  await clearRelayAuthError();

  // Tear down any stale connections before constructing new ones.
  teardownConnections();

  const userMode = await getStoredUserMode();

  // Bail if the user disconnected while we were awaiting above.
  if (!shouldConnect) return;

  if (userMode === "cloud") {
    // Cloud mode: connect via SSE to the platform API.
    currentAuthProfile = "vellum-cloud";
    const session = await getStoredSession();
    const selectedAssistant = await getSelectedAssistant();
    if (!session || !selectedAssistant) {
      setConnectionHealth("auth_required", {
        lastErrorMessage: "Sign in and select an assistant to connect.",
      });
      return;
    }
    const env = await getEffectiveEnvironment();
    const { apiBaseUrl } = cloudUrlsForEnvironment(env);
    if (!shouldConnect) return;
    sseConnection = createSseConnection({
      kind: "vellum-cloud",
      runtimeUrl: apiBaseUrl,
      assistantId: selectedAssistant.id,
      token: null,
      sessionToken: session.sessionToken ?? null,
      organizationId: session.organizationId,
    });
    sseConnection.start();
  } else {
    // Self-hosted: pair first to obtain a JWT, then connect via SSE.
    currentAuthProfile = "self-hosted";
    const gatewayUrl = await getStoredGatewayUrl();
    if (!shouldConnect) return;

    // Best-effort pair — if pairing fails the SSE connection will be rejected
    // by the gateway with a 401 (the loopback-without-token bypass was removed
    // in ATL-429). The worker will surface the auth error and stop reconnecting
    // until the user re-pairs.
    try {
      const pairResp = await fetch(
        `${gatewayUrl.replace(/\/$/, "")}/v1/pair`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-vellum-interface-id": "chrome-extension",
          },
        },
      );
      if (pairResp.ok) {
        const body = (await pairResp.json()) as { token?: string };
        selfHostedPairToken = body.token ?? null;
      } else {
        console.warn("[vellum] pair failed:", pairResp.status);
      }
    } catch (err) {
      console.warn("[vellum] pair request error:", err);
    }

    if (!shouldConnect) return;
    sseConnection = createSseConnection({
      kind: "self-hosted",
      runtimeUrl: gatewayUrl,
      token: selfHostedPairToken,
    });
    sseConnection.start();
  }
}

/**
 * Tear down all active connections without resetting `shouldConnect`.
 * Used by `doConnect` to clean up stale instances before constructing
 * a new connection.
 */
function teardownConnections(): void {
  if (sseConnection) {
    sseConnection.close();
    sseConnection = null;
  }
  selfHostedPairToken = null;
}

function disconnect(): void {
  if (sseConnection) {
    sseConnection.close();
    sseConnection = null;
  }
}

// ── Extension message listener (from popup) ─────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponseFn) => {
  if (message.type === "connect") {
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
          setConnectionHealth("auth_required", {
            lastErrorMessage: errorMessage,
          });
        } else {
          setConnectionHealth("error", {
            lastErrorMessage: errorMessage,
          });
        }
        sendResponseFn({ ok: false, ...serializedError });
      });
    return true; // async
  }
  // `pause` is the canonical user-level stop action: it clears the
  // sticky auto-connect flag so the extension does not reconnect on
  // the next startup, then tears down the SSE connection.
  // `disconnect` is kept as a backward-compatible alias during rollout
  // — both actions perform identical state transitions.
  if (message.type === "pause" || message.type === "disconnect") {
    shouldConnect = false;
    setConnectionHealth("paused");
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
  if (message.type === "get_status") {
    sendResponseFn({
      connected: isAnyConnectionOpen(),
      authProfile: currentAuthProfile,
      health: connectionHealth,
      healthDetail: connectionHealthDetail,
    });
    return false;
  }
  if (message.type === "gateway-url-get") {
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
  if (message.type === "gateway-url-set") {
    const url =
      typeof message.gatewayUrl === "string" ? message.gatewayUrl.trim() : null;
    if (!url) {
      sendResponseFn({ ok: false, error: "gatewayUrl is required" });
      return false;
    }
    (async () => {
      await setStoredGatewayUrl(url);

      // When connected, tear down and reconnect to the new gateway.
      if (shouldConnect && sseConnection) {
        disconnect();
        try {
          await connect({ interactive: true });
        } catch (err) {
          shouldConnect = false;
          const errorMessage = err instanceof Error ? err.message : String(err);
          console.warn(
            `[vellum-relay] Gateway URL switch left disconnected: ${errorMessage}`,
          );
          if (err instanceof MissingTokenError) {
            setConnectionHealth("auth_required", {
              lastErrorMessage: errorMessage,
            });
          } else {
            setConnectionHealth("error", {
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
  if (message.type === "self-hosted-pair") {
    // The popup calls this when the user clicks "Pair" on the self-hosted
    // setup screen. We set the mode, attempt /v1/pair so the popup gets
    // early feedback, and store the JWT so callbacks work immediately when
    // the popup follows up with "connect".
    (async () => {
      const gatewayUrl = await getStoredGatewayUrl();
      await setStoredUserMode("self-hosted");
      const pairResp = await fetch(
        `${gatewayUrl.replace(/\/$/, "")}/v1/pair`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-vellum-interface-id": "chrome-extension",
          },
        },
      );
      if (!pairResp.ok) {
        throw new Error(`Pair failed (${pairResp.status})`);
      }
      const body = (await pairResp.json()) as { token?: string };
      selfHostedPairToken = body.token ?? null;
      sendResponseFn({ ok: true });
    })()
      .catch((err) =>
        sendResponseFn({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    return true; // async
  }
  if (message.type === "environment-get") {
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
  if (message.type === "environment-set") {
    // Validates and persists an environment override. Pass
    // `environment: null` to clear the override and revert to the
    // build default.
    //
    // NOTE: This handler only persists the override and invalidates
    // stale auth tokens — it does NOT disconnect or reconnect the
    // active SSE connection. The caller (popup) is responsible for
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
          void updateExtensionIcon(effectiveEnvironment);
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
    if (typeof rawEnv !== "string") {
      sendResponseFn({
        ok: false,
        error: "environment must be a string or null",
      });
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
        void updateExtensionIcon(effectiveEnvironment);
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

  if (message.type === "get-session") {
    (async () => {
      const session = await getStoredSession();
      const selectedAssistant = await getSelectedAssistant();
      let mode = await getStoredUserMode();

      // Backward compatibility: existing users who connected before
      // the onboarding flow was added will have autoConnect=true but
      // no userMode. Infer self-hosted so they skip the welcome screen.
      if (!mode) {
        const autoConnectResult =
          await chrome.storage.local.get(AUTO_CONNECT_KEY);
        if (autoConnectResult[AUTO_CONNECT_KEY] === true) {
          mode = "self-hosted";
          await setStoredUserMode("self-hosted");
        }
      }

      // Self-hosted is always "paired" — loopback peers are trusted
      // without credentials. The popup uses this to skip the pairing screen.
      const selfHostedPaired = mode === "self-hosted";

      sendResponseFn({
        ok: true,
        mode,
        session: session ? { email: session.email } : null,
        selectedAssistant,
        selfHostedPaired,
      });
    })().catch(() => sendResponseFn({ ok: false, mode: null }));
    return true; // async
  }

  if (message.type === "set-mode") {
    (async () => {
      const newMode = message.mode as "self-hosted" | "cloud";
      await setStoredUserMode(newMode);
      sendResponseFn({ ok: true });
    })().catch((err) =>
      sendResponseFn({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return true; // async
  }

  if (message.type === "cloud-login") {
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
      await setStoredUserMode("cloud");
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

  if (message.type === "cloud-logout") {
    (async () => {
      shouldConnect = false;
      disconnect();
      setConnectionHealth("paused");
      clearEventLog();
      await setAutoConnect(false);
      await clearSession();
      await clearSelectedAssistant();
      await clearStoredUserMode();
      sendResponseFn({ ok: true });
    })().catch(() => sendResponseFn({ ok: true }));
    return true; // async
  }

  if (message.type === "self-hosted-disconnect") {
    (async () => {
      shouldConnect = false;
      disconnect();
      setConnectionHealth("paused");
      clearEventLog();
      await setAutoConnect(false);
      await clearStoredUserMode();
      sendResponseFn({ ok: true });
    })().catch(() => sendResponseFn({ ok: true }));
    return true; // async
  }

  if (message.type === "list-assistants") {
    (async () => {
      const env = await getEffectiveEnvironment();
      const assistants = await fetchAssistants(env);
      sendResponseFn({ ok: true, assistants });
    })().catch((err) =>
      sendResponseFn({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return true; // async
  }

  if (message.type === "select-assistant") {
    (async () => {
      const assistantId = message.assistantId as string;
      const assistantName = message.assistantName as string;
      // Clear activity from the previous assistant so it doesn't carry over.
      clearEventLog();
      await storeSelectedAssistant({ id: assistantId, name: assistantName });
      sendResponseFn({ ok: true });
    })().catch((err) =>
      sendResponseFn({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return true; // async
  }

  if (message.type === "get-event-log") {
    sendResponseFn({ ok: true, entries: getEventLog() });
    return false; // synchronous
  }

  if (message.type === "get-operations") {
    sendResponseFn({ ok: true, operations: getOperations() });
    return false;
  }

  if (message.type === "get-operation-detail") {
    const op = getOperationById(message.operationId as number);
    sendResponseFn({ ok: !!op, operation: op ?? null });
    return false;
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
  // Set the toolbar icon to match the current environment on every
  // service-worker startup, regardless of auto-connect state.
  void updateExtensionIcon(await getEffectiveEnvironment());

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
      setConnectionHealth("auth_required", {
        lastErrorMessage: err.message,
      });
      void setRelayAuthError({
        message: err.message,
        mode: "self-hosted",
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
    setConnectionHealth("error", {
      lastErrorMessage: detail,
    });
    void setRelayAuthError({
      message: detail,
      mode: "self-hosted",
      at: Date.now(),
    });
  }
}

bootstrap();
