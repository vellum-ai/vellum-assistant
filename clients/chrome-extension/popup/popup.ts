/**
 * Popup UI for the Vellum browser-relay extension.
 *
 * Self-hosted pairing is governed by the "Pair local assistant" button,
 * which spawns the native messaging helper and persists a capability
 * token (see self-hosted-auth.ts). Connect then reads that stored
 * capability token directly — it does NOT fall back to the legacy
 * `/v1/browser-relay/token` gateway endpoint. If the user hasn't
 * paired yet we surface an inline error pointing them at the Pair
 * button instead of silently auto-fetching a JWT.
 *
 * Also exposes a "Sign in with Vellum (cloud)" button. The actual OAuth
 * flow runs in the background service worker (see worker.ts) — the popup
 * only sends a message asking the worker to start it. This avoids the
 * MV3 popup teardown race where closing the popup mid-auth would kill
 * the awaited launchWebAuthFlow promise before the token was persisted.
 * Cloud sign-in and self-hosted Pair coexist — they represent the two
 * possible relay transports.
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
const modeSelfHosted = document.getElementById('mode-self-hosted') as HTMLInputElement;
const modeCloud = document.getElementById('mode-cloud') as HTMLInputElement;

const RELAY_MODE_KEY = 'vellum.relayMode';
type RelayModeKind = 'self-hosted' | 'cloud';

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

/**
 * Render an inline error message without touching any other UI.
 *
 * Use this for errors that are not actionable by the self-hosted
 * manual-token-entry workflow — e.g. cloud OAuth failures, refresh
 * exceptions, or generic service-worker messages. It's specifically
 * the variant {@link refreshCloudStatus} uses so a cloud auth error
 * does not accidentally reveal the self-hosted token input.
 */
function showErrorText(msg: string): void {
  errorText.textContent = msg;
  errorText.style.display = 'block';
}

/**
 * Render an inline error message AND reveal the self-hosted manual
 * token entry section. Use this for errors where the user's next
 * action is to paste a bearer token into the manual-entry box —
 * e.g. a failed auto-fetch or a missing paired local assistant.
 *
 * Do NOT use this for cloud auth errors: the manual token entry
 * section is a self-hosted-only workflow, and revealing it for a
 * cloud error would point the user at the wrong remediation.
 */
function showError(msg: string): void {
  showErrorText(msg);
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

btnConnect.addEventListener('click', async () => {
  const port = getPort();
  const storageUpdate: Record<string, unknown> = { autoConnect: true };

  errorText.style.display = 'none';

  // Read the current relay mode so we know whether to auto-fetch a local
  // daemon token. In cloud mode the worker uses the stored cloud token
  // (vellum.cloudAuthToken) directly, so the popup must NOT try to hit
  // localhost — a cloud-only user may not have a local assistant running.
  //
  // We prefer the radio button's checked state as a tiebreaker: if the
  // user just toggled the radio, the async chrome.storage.local.set from
  // handleModeChange() may not have landed yet. The DOM is the source of
  // truth for the user's current intent.
  const modeStorage = await chrome.storage.local.get(RELAY_MODE_KEY);
  const storedMode = modeStorage[RELAY_MODE_KEY];
  const relayMode: RelayModeKind = modeCloud.checked
    ? 'cloud'
    : modeSelfHosted.checked
      ? 'self-hosted'
      : storedMode === 'cloud'
        ? 'cloud'
        : 'self-hosted';

  // Only honour the manual token input when the user has explicitly revealed
  // it. When manual mode is hidden and we're in self-hosted mode, we now
  // rely on the native-messaging Pair flow (PR 3 of the browser-remediation
  // plan): the stored capability token is what authenticates the relay
  // WebSocket, not a gateway-minted JWT. If the user hasn't paired yet we
  // refuse to auto-fetch from the gateway and instead surface an error
  // pointing them at the Pair button.
  //
  // Legacy compatibility: if a `bearerToken` was already written to storage
  // by a pre-PR 3 install, we still honour it (the worker's fallback branch
  // in buildRelayModeConfig will pick it up) so existing installs keep
  // working until they re-pair.
  let token = manualMode ? tokenInput.value.trim() : '';

  if (!token && relayMode === 'self-hosted') {
    const pairedToken = await getStoredLocalToken();
    if (!pairedToken) {
      // No capability token yet. Check for a legacy bearer token — that
      // path is honoured by the service worker's buildRelayModeConfig
      // fallback, so we let the worker take the connect attempt and
      // surface its MissingTokenError if there's nothing usable.
      const legacy = await chrome.storage.local.get('bearerToken');
      if (typeof legacy.bearerToken !== 'string' || !legacy.bearerToken) {
        showError(
          'Self-hosted relay is not paired yet — click "Pair local assistant" below before connecting.',
        );
        return;
      }
      // Fall through: the worker will read the legacy bearer token and
      // connect to the compatibility branch.
    }
    // When we have a paired capability token we deliberately do NOT
    // write anything to the legacy `bearerToken` storage key — the
    // worker's buildRelayModeConfig reads the capability token
    // directly and persisting a stale bearer token here would just
    // leave orphaned state around after a future clearLocalToken.
  }

  // In cloud mode with no manual token we proceed with no bearerToken —
  // the worker reads vellum.cloudAuthToken from chrome.storage when it
  // builds the relay mode config in buildRelayModeConfig().

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
    // Surface any auth error the service worker persisted during a
    // reconnect. The worker writes `vellum.relayAuthError` when the
    // cloud token refresh fails (see cloudReconnectHook in worker.ts)
    // and clears it on a successful connect.
    //
    // Use showErrorText (NOT showError) here: the self-hosted manual
    // token entry section is irrelevant to a cloud auth error, and
    // revealing it would point the user at the wrong remediation.
    // The error message itself already instructs the user to sign
    // in with Vellum (cloud) again, which is all they need.
    const authErrResult = await chrome.storage.local.get('vellum.relayAuthError');
    const authErr = authErrResult['vellum.relayAuthError'];
    if (
      authErr &&
      typeof authErr === 'object' &&
      typeof (authErr as { message?: unknown }).message === 'string'
    ) {
      showErrorText((authErr as { message: string }).message);
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
  errorText.style.display = 'none';
  // Clear any stale auth-error the worker persisted during a failed
  // reconnect — the user is explicitly retrying sign-in now.
  await chrome.storage.local.remove('vellum.relayAuthError');
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

// ── Relay mode switcher (Phase 2 PR 14) ────────────────────────────
//
// Flips `vellum.relayMode` in chrome.storage.local between "self-hosted"
// (default, back-compat) and "cloud". The service worker listens for
// storage changes via chrome.storage.onChanged and closes the current
// socket + reopens a new one against the selected transport.

function isRelayModeKind(v: unknown): v is RelayModeKind {
  return v === 'self-hosted' || v === 'cloud';
}

chrome.storage.local.get(RELAY_MODE_KEY).then((result) => {
  const stored = result[RELAY_MODE_KEY];
  const mode: RelayModeKind = isRelayModeKind(stored) ? stored : 'self-hosted';
  if (mode === 'cloud') {
    modeCloud.checked = true;
  } else {
    modeSelfHosted.checked = true;
  }
});

async function handleModeChange(newMode: RelayModeKind): Promise<void> {
  await chrome.storage.local.set({ [RELAY_MODE_KEY]: newMode });
  // The service worker reacts to the storage change via
  // chrome.storage.onChanged — we don't need to send an explicit
  // disconnect/connect message here.
}

modeSelfHosted.addEventListener('change', () => {
  if (modeSelfHosted.checked) {
    void handleModeChange('self-hosted');
  }
});

modeCloud.addEventListener('change', () => {
  if (modeCloud.checked) {
    void handleModeChange('cloud');
  }
});
