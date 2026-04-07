/**
 * Popup UI for the Vellum browser-relay extension.
 *
 * Auto-fetches a bearer token from the local gateway on Connect.
 * Falls back to manual token entry if the gateway is unreachable.
 *
 * Also exposes a "Sign in with Vellum (cloud)" button. The actual OAuth
 * flow runs in the background service worker (see worker.ts) — the popup
 * only sends a message asking the worker to start it. This avoids the
 * MV3 popup teardown race where closing the popup mid-auth would kill
 * the awaited launchWebAuthFlow promise before the token was persisted.
 * Cloud sign-in and self-hosted token entry coexist — they represent
 * the two possible relay transports.
 */

import { getStoredToken, type StoredCloudToken } from '../background/cloud-auth.js';
import {
  getStoredLocalToken,
  type StoredLocalToken,
} from '../background/self-hosted-auth.js';

const DEFAULT_RELAY_PORT = 7830;

const tokenInput = document.getElementById('token-input') as HTMLInputElement;
const portInput = document.getElementById('port-input') as HTMLInputElement;
const btnConnect = document.getElementById('btn-connect') as HTMLButtonElement;
const btnDisconnect = document.getElementById('btn-disconnect') as HTMLButtonElement;
const statusDot = document.getElementById('status-dot') as HTMLDivElement;
const statusText = document.getElementById('status-text') as HTMLParagraphElement;
const errorText = document.getElementById('error-text') as HTMLParagraphElement;
const manualToggle = document.getElementById('manual-toggle') as HTMLButtonElement;
const tokenGroup = document.getElementById('token-group') as HTMLDivElement;
const btnCloudSignIn = document.getElementById('btn-cloud-signin') as HTMLButtonElement;
const cloudStatus = document.getElementById('cloud-status') as HTMLParagraphElement;
const btnPairLocal = document.getElementById('btn-pair-local') as HTMLButtonElement;
const localStatus = document.getElementById('local-status') as HTMLParagraphElement;
const cdpProxyToggle = document.getElementById('cdp-proxy-toggle') as HTMLInputElement;

const CDP_PROXY_ENABLED_KEY = 'vellum.cdpProxyEnabled';

let manualMode = false;

function setConnected(connected: boolean): void {
  statusDot.className = `status-dot ${connected ? 'connected' : 'disconnected'}`;
  statusText.textContent = connected ? 'Connected to relay server' : 'Not connected';
  btnConnect.disabled = connected;
  btnDisconnect.disabled = !connected;
  tokenInput.disabled = connected;
  portInput.disabled = connected;
  if (connected) {
    errorText.style.display = 'none';
  }
}

function showError(msg: string): void {
  errorText.textContent = msg;
  errorText.style.display = 'block';
  // Reveal manual token entry on auto-fetch failure
  if (!manualMode) {
    manualMode = true;
    tokenGroup.classList.add('visible');
    manualToggle.textContent = 'Hide manual token entry';
  }
}

manualToggle.addEventListener('click', () => {
  manualMode = !manualMode;
  tokenGroup.classList.toggle('visible', manualMode);
  manualToggle.textContent = manualMode ? 'Hide manual token entry' : 'Manual token entry';
});

// Load saved token and port on open
chrome.storage.local.get(['bearerToken', 'relayPort']).then((result) => {
  if (typeof result.bearerToken === 'string' && result.bearerToken) {
    tokenInput.value = result.bearerToken;
  }
  if (result.relayPort !== undefined) {
    portInput.value = String(result.relayPort);
  }
});

// Query current status from service worker
chrome.runtime.sendMessage({ type: 'get_status' }, (response: { connected: boolean }) => {
  if (chrome.runtime.lastError) return;
  setConnected(response?.connected ?? false);
});

function getPort(): number {
  const portStr = portInput.value.trim();
  if (portStr) {
    const portNum = parseInt(portStr, 10);
    if (!isNaN(portNum) && portNum > 0 && portNum <= 65535) return portNum;
  }
  return DEFAULT_RELAY_PORT;
}

async function fetchTokenFromGateway(port: number): Promise<string> {
  const resp = await fetch(`http://127.0.0.1:${port}/v1/browser-relay/token`);
  if (!resp.ok) {
    throw new Error(`Gateway returned ${resp.status}`);
  }
  const data = await resp.json();
  if (typeof data.token !== 'string') {
    throw new Error('Invalid token response');
  }
  return data.token;
}

btnConnect.addEventListener('click', async () => {
  const port = getPort();
  const storageUpdate: Record<string, unknown> = { autoConnect: true };

  errorText.style.display = 'none';

  // Only honour the manual token input when the user has explicitly revealed
  // it.  When manual mode is hidden, always auto-fetch a fresh token from the
  // gateway so we never silently reuse an expired JWT that was pre-loaded from
  // storage.
  let token = manualMode ? tokenInput.value.trim() : '';

  if (!token) {
    try {
      btnConnect.disabled = true;
      statusText.textContent = 'Fetching token…';
      token = await fetchTokenFromGateway(port);
    } catch (err) {
      btnConnect.disabled = false;
      showError(`Could not auto-fetch token: ${err instanceof Error ? err.message : String(err)}`);
      statusText.textContent = 'Not connected';
      return;
    }
  }

  if (token) storageUpdate.bearerToken = token;
  if (portInput.value.trim()) {
    storageUpdate.relayPort = port;
  } else {
    await chrome.storage.local.remove('relayPort');
  }
  await chrome.storage.local.set(storageUpdate);

  chrome.runtime.sendMessage({ type: 'connect' }, (response: { ok: boolean; error?: string }) => {
    if (chrome.runtime.lastError || !response?.ok) {
      showError(response?.error ?? chrome.runtime.lastError?.message ?? 'Unknown error');
      btnConnect.disabled = false;
      return;
    }
    // Poll briefly for open state
    let attempts = 0;
    const poll = setInterval(() => {
      chrome.runtime.sendMessage({ type: 'get_status' }, (r: { connected: boolean }) => {
        if (r?.connected || ++attempts > 10) {
          clearInterval(poll);
          setConnected(r?.connected ?? false);
        }
      });
    }, 300);
  });
});

btnDisconnect.addEventListener('click', () => {
  chrome.storage.local.set({ autoConnect: false });
  chrome.runtime.sendMessage({ type: 'disconnect' }, () => {
    setConnected(false);
  });
});

// ── Self-hosted native-messaging pairing (new in Phase 2 PR 13) ─────
//
// Pairing runs the local native messaging helper (com.vellum.daemon),
// which POSTs the extension's origin to the assistant's
// `/v1/browser-extension-pair` endpoint and returns a capability token.
// The token is persisted in chrome.storage.local under
// `vellum.localCapabilityToken`. It is NOT yet used on any WebSocket —
// PR 14 will read it when opening the relay connection in self-hosted
// mode.

function setLocalStatus(text: string, state: 'neutral' | 'paired' | 'error'): void {
  localStatus.textContent = text;
  localStatus.classList.remove('paired', 'error');
  if (state !== 'neutral') localStatus.classList.add(state);
}

function formatLocalTokenStatus(token: StoredLocalToken): string {
  const expiresDate = new Date(token.expiresAt);
  const expiresStr = Number.isFinite(token.expiresAt)
    ? expiresDate.toLocaleString()
    : 'unknown';
  return `Paired as guardian:${token.guardianId} (expires ${expiresStr})`;
}

async function refreshLocalStatus(): Promise<void> {
  try {
    const existing = await getStoredLocalToken();
    if (existing) {
      setLocalStatus(formatLocalTokenStatus(existing), 'paired');
    } else {
      setLocalStatus('Not paired', 'neutral');
    }
  } catch (err) {
    setLocalStatus(
      `Error: ${err instanceof Error ? err.message : String(err)}`,
      'error',
    );
  }
}

interface LocalPairResponse {
  ok: boolean;
  token?: StoredLocalToken;
  error?: string;
}

function requestLocalPair(): Promise<LocalPairResponse> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'self-hosted-pair' }, (response: LocalPairResponse) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message ?? 'Unknown error' });
        return;
      }
      resolve(response ?? { ok: false, error: 'No response from service worker' });
    });
  });
}

btnPairLocal.addEventListener('click', async () => {
  btnPairLocal.disabled = true;
  setLocalStatus('Pairing…', 'neutral');
  // Delegate to the service worker so the native-messaging bootstrap
  // survives the popup teardown race — see the `self-hosted-pair`
  // handler in worker.ts, and the matching cloud-auth-sign-in pattern.
  const response = await requestLocalPair();
  if (response.ok && response.token) {
    setLocalStatus(formatLocalTokenStatus(response.token), 'paired');
  } else {
    setLocalStatus(`Pairing failed: ${response.error ?? 'Unknown error'}`, 'error');
  }
  btnPairLocal.disabled = false;
});

refreshLocalStatus();

// ── Cloud sign-in (new in Phase 2 PR 8) ────────────────────────────
//
// This is a skeleton: the token is persisted but not yet used on any
// WebSocket. A later PR will plumb it through the relay connection so
// cloud-hosted users can connect to the Vellum gateway without running
// a local daemon.

function setCloudStatus(text: string, signedIn: boolean): void {
  cloudStatus.textContent = text;
  cloudStatus.classList.toggle('signed-in', signedIn);
}

async function refreshCloudStatus(): Promise<void> {
  try {
    const existing = await getStoredToken();
    if (existing) {
      setCloudStatus(`Signed in as guardian:${existing.guardianId}`, true);
    } else {
      setCloudStatus('Not signed in', false);
    }
  } catch (err) {
    setCloudStatus(`Error: ${err instanceof Error ? err.message : String(err)}`, false);
  }
}

interface CloudSignInResponse {
  ok: boolean;
  token?: StoredCloudToken;
  error?: string;
}

function requestCloudSignIn(): Promise<CloudSignInResponse> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'cloud-auth-sign-in' }, (response: CloudSignInResponse) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message ?? 'Unknown error' });
        return;
      }
      resolve(response ?? { ok: false, error: 'No response from service worker' });
    });
  });
}

btnCloudSignIn.addEventListener('click', async () => {
  btnCloudSignIn.disabled = true;
  setCloudStatus('Signing in…', false);
  // Delegate to the service worker — see header comment for the rationale.
  const response = await requestCloudSignIn();
  if (response.ok && response.token) {
    setCloudStatus(`Signed in as guardian:${response.token.guardianId}`, true);
  } else {
    setCloudStatus(`Sign-in failed: ${response.error ?? 'Unknown error'}`, false);
  }
  btnCloudSignIn.disabled = false;
});

refreshCloudStatus();

// ── CDP proxy beta toggle (Phase 2 PR 9) ──────────────────────────
//
// Persists `vellum.cdpProxyEnabled` in chrome.storage.local. The service
// worker reads this flag at startup and listens for changes via
// chrome.storage.onChanged, so no reconnect is needed — flipping the
// checkbox takes effect on the next incoming host_browser_request frame.

chrome.storage.local.get(CDP_PROXY_ENABLED_KEY).then((result) => {
  cdpProxyToggle.checked = result[CDP_PROXY_ENABLED_KEY] === true;
});

cdpProxyToggle.addEventListener('change', async () => {
  await chrome.storage.local.set({ [CDP_PROXY_ENABLED_KEY]: cdpProxyToggle.checked });
});
