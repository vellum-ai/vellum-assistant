/**
 * Popup UI for the Vellum browser-relay extension.
 *
 * The popup exposes a single primary CTA — **Connect** — that works in
 * one click even when the user hasn't previously paired or signed in.
 * The worker handles auth bootstrap automatically when `interactive=true`.
 *
 * The secondary action is **Pause**, which halts the relay but preserves
 * credentials for instant reconnect. Under the hood this sends the
 * existing `disconnect` message to the worker; once PR 2 lands it will
 * migrate to the dedicated `pause` message.
 *
 * Manual recovery controls (local re-pair and cloud re-sign-in) are
 * available under a Troubleshooting section, but are not required for
 * the normal connect flow.
 *
 * On open the popup loads the assistant catalog from the worker via the
 * `assistants-get` message. When exactly one assistant exists it is
 * auto-selected and no selector dropdown is shown. When multiple
 * assistants exist a `<select>` dropdown is rendered in lockfile order.
 *
 * Switching assistants sends an `assistant-select` message to the
 * worker, which persists the selection and returns the resolved
 * descriptor + auth profile. The popup then refreshes the local/cloud
 * auth status panels to match the newly selected assistant.
 */

import { getStoredToken, type StoredCloudToken } from '../background/cloud-auth.js';
import {
  getStoredLocalToken,
  type StoredLocalToken,
} from '../background/self-hosted-auth.js';
import type { AssistantDescriptor } from '../background/native-host-assistants.js';
import type { AssistantAuthProfile } from '../background/assistant-auth-profile.js';
import {
  deriveSelectorDisplay,
  shouldShowLocalSection,
  shouldShowCloudSection,
  deriveCtaState,
  deriveStatusDisplay,
  type ConnectionPhase,
  type AssistantsGetResponse,
  type AssistantSelectResponse,
} from './popup-state.js';

const DEFAULT_RELAY_PORT = 7830;

// ── DOM references ──────────────────────────────────────────────────

const portInput = document.getElementById('port-input') as HTMLInputElement;
const btnConnect = document.getElementById('btn-connect') as HTMLButtonElement;
const btnPause = document.getElementById('btn-pause') as HTMLButtonElement;
const statusDot = document.getElementById('status-dot') as HTMLDivElement;
const statusText = document.getElementById('status-text') as HTMLParagraphElement;
const errorText = document.getElementById('error-text') as HTMLParagraphElement;
const btnCloudSignIn = document.getElementById('btn-cloud-signin') as HTMLButtonElement;
const cloudStatus = document.getElementById('cloud-status') as HTMLParagraphElement;
const btnPairLocal = document.getElementById('btn-pair-local') as HTMLButtonElement;
const localStatus = document.getElementById('local-status') as HTMLParagraphElement;

const assistantSelectorGroup = document.getElementById(
  'assistant-selector-group',
) as HTMLDivElement;
const assistantSelect = document.getElementById(
  'assistant-select',
) as HTMLSelectElement;

// ── Current assistant state ─────────────────────────────────────────
//
// Tracks the currently selected assistant and its auth profile so
// connect and auth-refresh operations use the right assistant context.

let currentAuthProfile: AssistantAuthProfile | null = null;
let currentAssistantId: string | null = null;

// ── Connection phase management ─────────────────────────────────────

let currentPhase: ConnectionPhase = 'disconnected';

/**
 * Apply a connection phase to the UI. Derives button labels/enablement
 * and status indicator from the pure helpers in popup-state.ts.
 */
function setPhase(phase: ConnectionPhase): void {
  currentPhase = phase;

  const cta = deriveCtaState(phase);
  btnConnect.textContent = cta.connectLabel;
  btnConnect.disabled = !cta.connectEnabled;
  btnPause.textContent = cta.pauseLabel;
  btnPause.disabled = !cta.pauseEnabled;

  const status = deriveStatusDisplay(phase);
  statusDot.className = `status-dot ${status.dotClass}`;
  statusText.textContent = status.text;

  portInput.disabled = phase === 'connected' || phase === 'connecting';

  if (phase === 'connected') {
    errorText.style.display = 'none';
  }
}

/**
 * Render an inline error message without touching any other UI.
 *
 * Use this for generic popup errors — e.g. cloud OAuth failures,
 * refresh exceptions, or generic service-worker messages.
 */
function showErrorText(msg: string): void {
  errorText.textContent = msg;
  errorText.style.display = 'block';
}

function showError(msg: string): void {
  showErrorText(msg);
}

// ── Assistant selector ──────────────────────────────────────────────

/**
 * Render the assistant dropdown based on the catalog from the worker.
 * Hides the dropdown when only one assistant exists.
 */
function renderAssistantSelector(
  assistants: AssistantDescriptor[],
  selected: AssistantDescriptor | null,
): void {
  const display = deriveSelectorDisplay(assistants, selected);

  if (display.kind === 'hidden') {
    assistantSelectorGroup.style.display = 'none';
    return;
  }

  // Build <option> elements in lockfile order.
  assistantSelect.innerHTML = '';
  for (const opt of display.options) {
    const el = document.createElement('option');
    el.value = opt.assistantId;
    el.textContent = opt.label;
    if (opt.assistantId === display.selectedId) {
      el.selected = true;
    }
    assistantSelect.appendChild(el);
  }

  assistantSelectorGroup.style.display = 'block';
}

/**
 * Update the visibility of the Local and Cloud troubleshooting controls
 * based on the selected assistant's auth profile.
 */
function updateAuthSections(authProfile: AssistantAuthProfile | null): void {
  currentAuthProfile = authProfile;

  const showLocal = shouldShowLocalSection(authProfile);
  const showCloud = shouldShowCloudSection(authProfile);

  // Toggle Local troubleshooting elements visibility.
  localStatus.style.display = showLocal ? '' : 'none';
  btnPairLocal.style.display = showLocal ? '' : 'none';

  // Toggle Cloud troubleshooting elements visibility.
  cloudStatus.style.display = showCloud ? '' : 'none';
  btnCloudSignIn.style.display = showCloud ? '' : 'none';
}

/**
 * Load the assistant catalog from the worker and render the selector.
 */
function loadAssistantCatalog(): void {
  chrome.runtime.sendMessage({ type: 'assistants-get' }, (response: AssistantsGetResponse) => {
    if (chrome.runtime.lastError || !response?.ok) {
      const errMsg = response?.error ?? chrome.runtime.lastError?.message ?? 'Failed to load assistants';
      showError(errMsg);
      return;
    }

    const assistants = response.assistants ?? [];
    const selected = response.selected ?? null;
    const authProfile = response.authProfile ?? null;

    currentAssistantId = selected?.assistantId ?? null;

    renderAssistantSelector(assistants, selected);
    updateAuthSections(authProfile);

    // Refresh status panels for the selected assistant.
    void refreshLocalStatus();
    void refreshCloudStatus();
  });
}

// Load on popup open.
loadAssistantCatalog();

// ── Assistant selection change ──────────────────────────────────────

assistantSelect.addEventListener('change', () => {
  const assistantId = assistantSelect.value;
  if (!assistantId) return;

  errorText.style.display = 'none';

  chrome.runtime.sendMessage(
    { type: 'assistant-select', assistantId },
    (response: AssistantSelectResponse) => {
      if (chrome.runtime.lastError || !response?.ok) {
        showError(
          response?.error ??
            chrome.runtime.lastError?.message ??
            'Failed to select assistant',
        );
        return;
      }

      currentAssistantId = response.selected?.assistantId ?? assistantId;
      const authProfile = response.authProfile ?? null;
      updateAuthSections(authProfile);

      // Refresh both status panels to reflect the new assistant.
      void refreshLocalStatus();
      void refreshCloudStatus();
    },
  );
});

// Load saved relay port on open.
chrome.storage.local.get(['relayPort']).then((result) => {
  if (result.relayPort !== undefined) {
    portInput.value = String(result.relayPort);
  }
});

// Query current status from service worker
chrome.runtime.sendMessage({ type: 'get_status' }, (response: { connected: boolean }) => {
  if (chrome.runtime.lastError) return;
  setPhase(response?.connected ? 'connected' : 'disconnected');
});

function getPort(): number {
  const portStr = portInput.value.trim();
  if (portStr) {
    const portNum = parseInt(portStr, 10);
    if (!isNaN(portNum) && portNum > 0 && portNum <= 65535) return portNum;
  }
  return DEFAULT_RELAY_PORT;
}

// ── Connect (primary CTA) ───────────────────────────────────────────
//
// No local precheck — the worker handles auth bootstrap (pairing/sign-in)
// automatically when interactive=true. Users can connect in one click
// even when not previously paired or signed in.

btnConnect.addEventListener('click', async () => {
  const port = getPort();
  const storageUpdate: Record<string, unknown> = { autoConnect: true };

  errorText.style.display = 'none';
  setPhase('connecting');

  if (portInput.value.trim()) {
    storageUpdate.relayPort = port;
  } else {
    await chrome.storage.local.remove('relayPort');
  }
  await chrome.storage.local.set(storageUpdate);

  chrome.runtime.sendMessage({ type: 'connect' }, (response: { ok: boolean; error?: string }) => {
    if (chrome.runtime.lastError || !response?.ok) {
      showError(response?.error ?? chrome.runtime.lastError?.message ?? 'Unknown error');
      setPhase('disconnected');
      return;
    }
    // Poll briefly for open state
    let attempts = 0;
    const poll = setInterval(() => {
      chrome.runtime.sendMessage({ type: 'get_status' }, (r: { connected: boolean }) => {
        if (r?.connected || ++attempts > 10) {
          clearInterval(poll);
          setPhase(r?.connected ? 'connected' : 'disconnected');
        }
      });
    }, 300);
  });
});

// ── Pause (secondary action) ────────────────────────────────────────
//
// Sends the existing disconnect/stop message to the worker while
// presenting the action as "Pause" in the UI. Credentials are
// preserved so reconnect is instant. Once PR 2 lands, this will
// migrate to the dedicated `pause` message.

btnPause.addEventListener('click', () => {
  chrome.storage.local.set({ autoConnect: false });
  chrome.runtime.sendMessage({ type: 'disconnect' }, () => {
    setPhase('paused');
  });
});

// ── Self-hosted native-messaging pairing (troubleshooting) ──────────
//
// Pairing runs the local native messaging helper (com.vellum.daemon),
// which POSTs the extension's origin to the assistant's
// `/v1/browser-extension-pair` endpoint and returns a capability token.
// The token is persisted in chrome.storage.local under
// `vellum.localCapabilityToken` and is used directly by the
// self-hosted relay WebSocket connection.
//
// This is a manual recovery control — normal connect handles pairing
// automatically via the worker's interactive bootstrap.

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
  if (!currentAssistantId) {
    setLocalStatus('Not paired', 'neutral');
    return;
  }
  try {
    const existing = await getStoredLocalToken(currentAssistantId);
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
    const msg: Record<string, unknown> = { type: 'self-hosted-pair' };
    if (currentAssistantId) {
      msg.assistantId = currentAssistantId;
    }
    chrome.runtime.sendMessage(msg, (response: LocalPairResponse) => {
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
  setLocalStatus('Pairing\u2026', 'neutral');
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

// ── Cloud sign-in (troubleshooting) ─────────────────────────────────
//
// The token is persisted and consumed by the background worker when
// opening cloud relay WebSocket connections.
//
// This is a manual recovery control — normal connect handles cloud
// sign-in automatically via the worker's interactive bootstrap.

function setCloudStatus(text: string, signedIn: boolean): void {
  cloudStatus.textContent = text;
  cloudStatus.classList.toggle('signed-in', signedIn);
}

async function refreshCloudStatus(): Promise<void> {
  if (!currentAssistantId) {
    setCloudStatus('Not signed in', false);
    return;
  }
  try {
    const existing = await getStoredToken(currentAssistantId);
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
    // Use showErrorText directly: the message already instructs the
    // user to sign in with Vellum (cloud) again, which is all they need.
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
  setCloudStatus('Signing in\u2026', false);
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
