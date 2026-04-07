/**
 * Chrome MV3 service worker — browser-relay bridge.
 *
 * Connects to ws://127.0.0.1:<relayPort>/v1/browser-relay and dispatches
 * ExtensionCommands from the server to browser APIs, sending back
 * ExtensionResponses.
 */

import type { ExtensionCommand, ExtensionResponse, ExtensionHeartbeat } from '../../../assistant/src/browser-extension-relay/protocol.js';
import { signInCloud, type CloudAuthConfig, type StoredCloudToken } from './cloud-auth.js';

// Cloud OAuth defaults — kept here so the popup can stay a thin client and the
// service worker is the single owner of the launchWebAuthFlow lifecycle. This
// avoids the MV3 popup teardown race where closing the popup mid-auth kills
// the awaited promise before the token is persisted.
//
// PR 14 will plumb these through config; hard-coded for the Phase 2 skeleton.
const CLOUD_GATEWAY_BASE_URL = 'https://api.vellum.ai';
const CLOUD_OAUTH_CLIENT_ID = 'vellum-chrome-extension';

const DEFAULT_RELAY_PORT = 7830;
const HEARTBEAT_INTERVAL_MS = 30_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

const EXTENSION_VERSION = chrome.runtime.getManifest().version;

let ws: WebSocket | null = null;
let reconnectDelay = RECONNECT_BASE_MS;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let shouldConnect = false;

/** WebSocket close codes that represent intentional, non-error closures. */
const NORMAL_CLOSE_CODES = new Set([1000, 1001]);

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

// ── WebSocket lifecycle ─────────────────────────────────────────────

async function connect(): Promise<void> {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  const [token, port] = await Promise.all([getBearerToken(), getRelayPort()]);
  const relayUrlBase = `ws://127.0.0.1:${port}/v1/browser-relay`;
  const url = token ? `${relayUrlBase}?token=${encodeURIComponent(token)}` : relayUrlBase;

  ws = new WebSocket(url);

  ws.addEventListener('open', () => {
    console.log('[vellum-relay] Connected to relay server');
    reconnectDelay = RECONNECT_BASE_MS;
    startHeartbeat();
  });

  ws.addEventListener('message', (event) => {
    handleServerMessage(event.data as string);
  });

  ws.addEventListener('close', (event) => {
    console.log(`[vellum-relay] Disconnected (code=${event.code}). Reconnecting in ${reconnectDelay}ms…`);
    stopHeartbeat();
    ws = null;
    if (shouldConnect) {
      if (!NORMAL_CLOSE_CODES.has(event.code)) {
        // Any unexpected close (including 1006 from failed HTTP 401 handshakes,
        // 1008, 4001, etc.) — attempt a token refresh before reconnecting.
        refreshToken().then(() => scheduleReconnect());
      } else {
        scheduleReconnect();
      }
    }
  });

  ws.addEventListener('error', () => {
    // close event will follow; just log
    console.warn('[vellum-relay] WebSocket error');
  });
}

function scheduleReconnect(): void {
  setTimeout(() => {
    if (shouldConnect) connect();
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
}

function startHeartbeat(): void {
  stopHeartbeat();
  heartbeatTimer = setInterval(async () => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const tabs = await chrome.tabs.query({});
    const heartbeat: ExtensionHeartbeat = {
      type: 'heartbeat',
      extensionVersion: EXTENSION_VERSION,
      connectedTabs: tabs.length,
    };
    ws.send(JSON.stringify(heartbeat));
  }, HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeat(): void {
  if (heartbeatTimer !== null) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function sendResponse(response: ExtensionResponse): void {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(response));
  }
}

// ── Command dispatch ────────────────────────────────────────────────

async function handleServerMessage(raw: string): Promise<void> {
  let cmd: ExtensionCommand;
  try {
    cmd = JSON.parse(raw) as ExtensionCommand;
  } catch {
    console.warn('[vellum-relay] Failed to parse server message');
    return;
  }

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

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'connect') {
    shouldConnect = true;
    connect().then(() => sendResponse({ ok: true })).catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true; // async
  }
  if (message.type === 'disconnect') {
    shouldConnect = false;
    ws?.close(1000, 'User disconnected');
    sendResponse({ ok: true });
    return false;
  }
  if (message.type === 'get_status') {
    sendResponse({
      connected: ws !== null && ws.readyState === WebSocket.OPEN,
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
      .then((stored: StoredCloudToken) => sendResponse({ ok: true, token: stored }))
      .catch((err) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    return true; // async
  }
});

// Auto-connect on service worker start if previously connected.
// Refresh the token first so we don't reconnect with stale credentials.
chrome.storage.local.get('autoConnect').then(async (result) => {
  if (result.autoConnect === true) {
    shouldConnect = true;
    await refreshToken();
    connect();
  }
});
