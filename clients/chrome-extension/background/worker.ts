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
 * Once connected, the worker dispatches incoming server messages:
 *   - `host_browser_request` / `host_browser_cancel` envelopes are
 *     routed to the CDP proxy dispatcher (Phase 2 PR 9, gated behind
 *     the `vellum.cdpProxyEnabled` feature flag).
 *   - Every other payload is treated as a legacy `ExtensionCommand`
 *     and dispatched to the existing browser-API handlers.
 */

import type { ExtensionCommand, ExtensionResponse, ExtensionHeartbeat } from '../../../assistant/src/browser-extension-relay/protocol.js';
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
const HEARTBEAT_INTERVAL_MS = 30_000;

const EXTENSION_VERSION = chrome.runtime.getManifest().version;

// ── Mode selection (Phase 2 PR 14) ─────────────────────────────────
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
// Active RelayMode (mode kind + base URL + token) captured at connect
// time. Tracked alongside `relayConnection` so the host-browser
// dispatcher's `postResult` callback can route results back through the
// correct transport (cloud WebSocket vs self-hosted HTTP) using the
// same credentials the live socket was opened with.
let activeRelayMode: RelayMode | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let shouldConnect = false;

// ── Host browser dispatcher (Phase 2 PR 9) ──────────────────────────
//
// Feature-flagged behind `vellum.cdpProxyEnabled` in chrome.storage.local.
// When the flag is off (default), incoming `host_browser_request` /
// `host_browser_cancel` envelopes are ignored here and the legacy
// ExtensionCommand handlers below service all browser tool calls exactly
// as before. Phase 3 will flip the default and delete the legacy path.
const CDP_PROXY_ENABLED_KEY = 'vellum.cdpProxyEnabled';

let cdpProxyEnabled = false;

async function resolveHostBrowserTarget(
  cdpSessionId: string | undefined,
): Promise<{ tabId?: number; targetId?: string }> {
  // When the daemon side has an explicit session id (e.g. a flat child
  // session returned from a prior Target.attachToTarget) we route the
  // command by targetId. Otherwise we fall back to the most recently
  // active tab in the focused window — matching the implicit target
  // selection the legacy ExtensionCommand handlers used.
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
 * {@link postHostBrowserResult} helper. Reads the live `activeRelayMode`
 * and `relayConnection` so a result envelope generated mid-session is
 * always shipped through the transport that's currently connected — not
 * a stale snapshot captured at module init.
 *
 * Falls back to a self-hosted POST against the bare bearer token + relay
 * port when no relay session has been established yet (e.g. the host
 * browser dispatcher fired before `connect()` ran). This preserves the
 * pre-Phase 2 behaviour for the legacy ExtensionCommand → daemon path.
 */
async function dispatchHostBrowserResult(
  result: HostBrowserResultEnvelope,
): Promise<void> {
  if (activeRelayMode) {
    return postHostBrowserResult(activeRelayMode, relayConnection, result);
  }
  const [token, port] = await Promise.all([getBearerToken(), getRelayPort()]);
  const fallback: RelayMode = {
    kind: 'self-hosted',
    baseUrl: `http://127.0.0.1:${port}`,
    token,
  };
  return postHostBrowserResult(fallback, null, result);
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
      startHeartbeat();
    },
    onMessage: (data) => {
      handleServerMessage(data);
    },
    onClose: (code, reason) => {
      console.log(`[vellum-relay] Disconnected (code=${code}, reason=${reason || 'n/a'})`);
      stopHeartbeat();
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
  const mode = await buildRelayModeConfig(relayMode);
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
  // Stash the resolved mode so the host-browser dispatcher can route
  // results back through the same transport (cloud WebSocket vs
  // self-hosted HTTP) without re-resolving the token / base URL.
  activeRelayMode = mode;
  relayConnection.start();
}

function disconnect(): void {
  stopHeartbeat();
  if (relayConnection) {
    relayConnection.close(1000, 'User disconnected');
    relayConnection = null;
  }
  activeRelayMode = null;
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

function startHeartbeat(): void {
  stopHeartbeat();
  heartbeatTimer = setInterval(async () => {
    if (!relayConnection || !relayConnection.isOpen()) return;
    const tabs = await chrome.tabs.query({});
    const heartbeat: ExtensionHeartbeat = {
      type: 'heartbeat',
      extensionVersion: EXTENSION_VERSION,
      connectedTabs: tabs.length,
    };
    relayConnection.send(JSON.stringify(heartbeat));
  }, HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeat(): void {
  if (heartbeatTimer !== null) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function sendResponse(response: ExtensionResponse): void {
  if (relayConnection && relayConnection.isOpen()) {
    relayConnection.send(JSON.stringify(response));
  }
}

// ── Command dispatch ────────────────────────────────────────────────

async function handleServerMessage(raw: string): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn('[vellum-relay] Failed to parse server message');
    return;
  }

  // Phase 2 PR 9: host_browser_* envelopes are dispatched via the CDP proxy
  // only when the feature flag is on. With the flag off we return early and
  // let the daemon's host-browser-proxy time out gracefully — the envelope
  // is NOT forwarded to the legacy ExtensionCommand dispatch because its
  // shape is incompatible.
  if (
    parsed !== null &&
    typeof parsed === 'object' &&
    'type' in parsed &&
    typeof (parsed as { type: unknown }).type === 'string'
  ) {
    const envelopeType = (parsed as { type: string }).type;
    if (envelopeType === 'host_browser_request') {
      if (!cdpProxyEnabled) return;
      await hostBrowserDispatcher.handle(parsed as HostBrowserRequestEnvelope);
      return;
    }
    if (envelopeType === 'host_browser_cancel') {
      if (cdpProxyEnabled) {
        hostBrowserDispatcher.cancel(parsed as HostBrowserCancelEnvelope);
      }
      return;
    }
  }

  const cmd = parsed as ExtensionCommand;
  try {
    const result = await dispatch(cmd);
    sendResponse({ id: cmd.id, success: true, ...result });
  } catch (err) {
    sendResponse({
      id: cmd.id,
      success: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

interface DispatchResult {
  result?: unknown;
  tabId?: number;
}

async function dispatch(cmd: ExtensionCommand): Promise<DispatchResult> {
  switch (cmd.action) {
    case 'evaluate':
      return await handleEvaluate(cmd);
    case 'navigate':
      return await handleNavigate(cmd);
    case 'find_tab':
      return await handleFindTab(cmd);
    case 'new_tab':
      return await handleNewTab(cmd);
    case 'get_cookies':
      return await handleGetCookies(cmd);
    case 'set_cookie':
      return await handleSetCookie(cmd);
    case 'screenshot':
      return await handleScreenshot(cmd);
    default:
      throw new Error(`Unknown action: ${(cmd as { action: string }).action}`);
  }
}

// ── Action handlers ─────────────────────────────────────────────────

async function handleEvaluate(cmd: ExtensionCommand): Promise<DispatchResult> {
  if (cmd.tabId === undefined) throw new Error('evaluate requires tabId');
  if (!cmd.code) throw new Error('evaluate requires code');

  const code = cmd.code;

  // Use chrome.debugger API (CDP Runtime.evaluate) for ALL evaluations.
  //
  // Why not chrome.scripting.executeScript?
  //   1. MAIN world + eval/new Function is blocked by CSP on Instagram, Facebook,
  //      TikTok, and many other sites.
  //   2. MAIN world results don't serialize back through executeScript reliably
  //      (returns null even when the script succeeds).
  //   3. ISOLATED world can't access page JS globals or cookie-authenticated fetch().
  //
  // The debugger API operates at the browser engine level, bypassing ALL CSP
  // restrictions while having full access to the page context (DOM, fetch,
  // cookies, JS globals). It's the only approach that works universally.
  //
  // Trade-off: Chrome shows a yellow "debugging this tab" infobar while
  // attached. We minimize this by attaching and detaching for each command.

  // Attach debugger to the tab
  try {
    await chrome.debugger.attach({ tabId: cmd.tabId }, '1.3');
  } catch (e) {
    // Already attached is fine
    if (!(e instanceof Error && e.message.includes('Already attached'))) {
      throw new Error(`Could not attach debugger: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  try {
    // Wrap code in an IIFE so "return" statements work — but only if the code
    // isn't already a self-executing expression (e.g. "(async function(){...})()"
    // or "(function(){...})()"). Double-wrapping breaks the return value.
    const trimmed = code.trim();
    const isIIFE = /^\((?:async\s+)?function\s*\(/.test(trimmed) && trimmed.endsWith(')');
    const wrapped = isIIFE ? trimmed : `(function(){ ${code} })()`;
    const evalResult = await chrome.debugger.sendCommand(
      { tabId: cmd.tabId },
      'Runtime.evaluate',
      {
        expression: wrapped,
        returnByValue: true,
        awaitPromise: true,
        userGesture: true,
      },
    ) as { result?: { value?: unknown; type?: string; description?: string }; exceptionDetails?: { text?: string; exception?: { description?: string } } };

    if (evalResult.exceptionDetails) {
      const errMsg = evalResult.exceptionDetails.exception?.description
        ?? evalResult.exceptionDetails.text
        ?? 'Unknown eval error';
      throw new Error(errMsg);
    }

    return { result: evalResult.result?.value ?? null, tabId: cmd.tabId };
  } finally {
    // Detach debugger — minimizes the yellow infobar visibility
    try {
      await chrome.debugger.detach({ tabId: cmd.tabId });
    } catch {
      // Best effort
    }
  }
}

async function handleNavigate(cmd: ExtensionCommand): Promise<DispatchResult> {
  if (!cmd.url) throw new Error('navigate requires url');
  const tabId = cmd.tabId;

  if (tabId !== undefined) {
    await chrome.tabs.update(tabId, { url: cmd.url });
    return { tabId };
  }

  // Navigate the active tab in the focused window
  const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!activeTab?.id) throw new Error('No active tab found');
  await chrome.tabs.update(activeTab.id, { url: cmd.url });
  return { tabId: activeTab.id };
}

async function handleFindTab(cmd: ExtensionCommand): Promise<DispatchResult> {
  if (!cmd.url) throw new Error('find_tab requires url');

  // Try URL match first
  const tabs = await chrome.tabs.query({ url: cmd.url });
  if (tabs.length > 0 && tabs[0].id !== undefined) {
    return { tabId: tabs[0].id };
  }

  // Fallback: substring match on tab URL
  const allTabs = await chrome.tabs.query({});
  const match = allTabs.find((t) => t.url?.includes(cmd.url!));
  if (match?.id !== undefined) {
    return { tabId: match.id };
  }

  return { tabId: undefined };
}

async function handleNewTab(cmd: ExtensionCommand): Promise<DispatchResult> {
  const tab = await chrome.tabs.create({ url: cmd.url });
  return { tabId: tab.id };
}

async function handleGetCookies(cmd: ExtensionCommand): Promise<DispatchResult> {
  if (!cmd.domain) throw new Error('get_cookies requires domain');
  const cookies = await chrome.cookies.getAll({ domain: cmd.domain });
  return { result: cookies };
}

async function handleSetCookie(cmd: ExtensionCommand): Promise<DispatchResult> {
  if (!cmd.cookie) throw new Error('set_cookie requires cookie');
  const { url, name, value, domain, path, secure, httpOnly, expirationDate } = cmd.cookie;
  await chrome.cookies.set({ url, name, value, domain, path, secure, httpOnly, expirationDate });
  return {};
}

async function handleScreenshot(cmd: ExtensionCommand): Promise<DispatchResult> {
  let windowId: number | undefined;
  if (cmd.tabId !== undefined) {
    const tab = await chrome.tabs.get(cmd.tabId);
    windowId = tab.windowId;
  }
  const dataUrl = await chrome.tabs.captureVisibleTab(windowId ?? chrome.windows.WINDOW_ID_CURRENT, {
    format: 'png',
  });
  return { result: dataUrl };
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
    //
    // IMPORTANT: use `sendResponseFn` (the chrome.runtime.onMessage
    // callback) — NOT the module-level `sendResponse` helper, which
    // forwards to the WebSocket relay and would leave the popup's
    // requestLocalPair() promise hanging forever.
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

// Load the CDP proxy feature flag at startup. Missing / non-boolean values
// are treated as false so existing deployments exhibit no behavior change.
chrome.storage.local.get(CDP_PROXY_ENABLED_KEY).then((result) => {
  const value = result[CDP_PROXY_ENABLED_KEY];
  cdpProxyEnabled = value === true;
  if (cdpProxyEnabled) {
    console.log('[vellum-relay] CDP proxy enabled (beta)');
  }
});

// Keep feature flag + relay mode live-updatable from the popup without
// requiring the service worker to restart.
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  if (CDP_PROXY_ENABLED_KEY in changes) {
    const newValue = changes[CDP_PROXY_ENABLED_KEY]?.newValue;
    cdpProxyEnabled = newValue === true;
    console.log(
      `[vellum-relay] CDP proxy feature flag updated: ${cdpProxyEnabled}`,
    );
  }
  if (RELAY_MODE_KEY in changes) {
    const newValue = changes[RELAY_MODE_KEY]?.newValue;
    if (isRelayModeKind(newValue)) {
      console.log(`[vellum-relay] Relay mode updated: ${newValue}`);
      void applyModeChange(newValue);
    }
  }
});
