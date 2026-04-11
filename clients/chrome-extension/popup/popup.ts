/**
 * Popup UI for the Vellum browser-relay extension.
 *
 * The popup renders a concise primary status derived from the worker's
 * structured connection health state:
 *   - **Connected** — relay active, everything working.
 *   - **Reconnecting automatically** — transient disconnect, auto-recovery
 *     in progress. No user action needed.
 *   - **Paused** — user explicitly paused the relay.
 *   - **Action required** — auth or host error requiring manual recovery.
 *
 * Primary controls are **Connect** and **Pause**. Manual recovery
 * controls (local re-pair and cloud re-sign-in) live in a collapsible
 * Troubleshoot section that is hidden by default. The section auto-
 * expands when the health state is `auth_required` or `error`, making
 * break-glass recovery accessible without cluttering the happy path.
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
  deriveHealthStatusDisplay,
  healthToPhase,
  shouldExpandTroubleshooting,
  hasTroubleshootingControls,
  type ConnectionHealthState,
  type ConnectionHealthDetail,
  type ConnectionPhase,
  type GetStatusResponse,
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

const troubleshootSection = document.getElementById(
  'troubleshoot-section',
) as HTMLDivElement;
const troubleshootToggle = document.getElementById(
  'troubleshoot-toggle',
) as HTMLButtonElement;
const troubleshootBody = document.getElementById(
  'troubleshoot-body',
) as HTMLDivElement;

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

// ── Current health state ────────────────────────────────────────────
//
// Tracks the latest health state from the worker so the troubleshoot
// section can react to state changes.

let currentHealthState: ConnectionHealthState = 'paused';

// ── Connection phase management ─────────────────────────────────────

/**
 * Apply the worker's health state to the full popup UI. Derives button
 * labels/enablement, status indicator, and troubleshooting section
 * visibility from the pure helpers in popup-state.ts.
 */
function applyHealthState(
  health: ConnectionHealthState,
  detail?: ConnectionHealthDetail,
): void {
  currentHealthState = health;

  // Derive phase for CTA button states.
  const phase = healthToPhase(health);
  const cta = deriveCtaState(phase);
  btnConnect.textContent = cta.connectLabel;
  btnConnect.disabled = !cta.connectEnabled;
  btnPause.textContent = cta.pauseLabel;
  btnPause.disabled = !cta.pauseEnabled;

  // Derive health-aware status display (richer than phase-based).
  const status = deriveHealthStatusDisplay(health, detail);
  statusDot.className = `status-dot ${status.dotClass}`;
  statusText.textContent = status.text;

  portInput.disabled = phase === 'connected' || phase === 'connecting';

  if (health === 'connected') {
    errorText.style.display = 'none';
  }

  // Update troubleshooting section visibility and expansion.
  updateTroubleshootSection(health);
}

/**
 * Backward-compatible wrapper: apply a connection phase to the UI
 * when only phase information is available (e.g. during the
 * connecting -> polling -> connected flow initiated by the popup).
 */
function setPhase(phase: ConnectionPhase): void {
  // Map phase back to a health state for the unified path.
  const healthMap: Record<ConnectionPhase, ConnectionHealthState> = {
    connected: 'connected',
    connecting: 'connecting',
    disconnected: 'paused',
    paused: 'paused',
  };
  applyHealthState(healthMap[phase]);
}

/**
 * Render an inline error message without touching any other UI.
 *
 * Use this for generic popup errors -- e.g. cloud OAuth failures,
 * refresh exceptions, or generic service-worker messages.
 */
function showErrorText(msg: string): void {
  errorText.textContent = msg;
  errorText.style.display = 'block';
}

function showError(msg: string): void {
  showErrorText(msg);
}

// ── Troubleshoot section ────────────────────────────────────────────

/**
 * Update the troubleshoot section visibility and expansion state.
 *
 * The section is shown when there are auth controls to display
 * (local-pair or cloud-oauth). It auto-expands when the health
 * state is `auth_required` or `error` so the user can access
 * recovery controls.
 */
function updateTroubleshootSection(health: ConnectionHealthState): void {
  const hasControls = hasTroubleshootingControls(currentAuthProfile);

  if (!hasControls) {
    troubleshootSection.hidden = true;
    return;
  }

  troubleshootSection.hidden = false;

  // Auto-expand when action is required, auto-collapse on recovery.
  if (shouldExpandTroubleshooting(health)) {
    expandTroubleshoot();
  } else if (health === 'connected') {
    collapseTroubleshoot();
  }
}

function expandTroubleshoot(): void {
  troubleshootBody.hidden = false;
  troubleshootToggle.setAttribute('aria-expanded', 'true');
}

function collapseTroubleshoot(): void {
  troubleshootBody.hidden = true;
  troubleshootToggle.setAttribute('aria-expanded', 'false');
}

// Toggle on click.
troubleshootToggle.addEventListener('click', () => {
  const expanded = troubleshootToggle.getAttribute('aria-expanded') === 'true';
  if (expanded) {
    collapseTroubleshoot();
  } else {
    expandTroubleshoot();
  }
});

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

  // Update troubleshoot section with current health state.
  updateTroubleshootSection(currentHealthState);
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

// Query current health state from service worker.
chrome.runtime.sendMessage({ type: 'get_status' }, (response: GetStatusResponse) => {
  if (chrome.runtime.lastError) return;

  // Use the structured health state if available, fall back to boolean.
  if (response?.health) {
    applyHealthState(response.health, response.healthDetail);
  } else {
    // Backward compatibility: older workers may not expose health.
    setPhase(response?.connected ? 'connected' : 'disconnected');
  }
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
// No local precheck -- the worker handles auth bootstrap (pairing/sign-in)
// automatically when interactive=true. Users can connect in one click
// even when not previously paired or signed in.

btnConnect.addEventListener('click', async () => {
  const port = getPort();

  errorText.style.display = 'none';
  setPhase('connecting');

  try {
    if (portInput.value.trim()) {
      await chrome.storage.local.set({ relayPort: port });
    } else {
      await chrome.storage.local.remove('relayPort');
    }
  } catch (err) {
    showError(err instanceof Error ? err.message : String(err));
    applyHealthState('error');
    return;
  }

  chrome.runtime.sendMessage({ type: 'connect' }, (response: { ok: boolean; error?: string }) => {
    if (chrome.runtime.lastError || !response?.ok) {
      showError(response?.error ?? chrome.runtime.lastError?.message ?? 'Unknown error');
      applyHealthState('error');
      return;
    }
    // Poll briefly for health state convergence.
    let attempts = 0;
    const poll = setInterval(() => {
      chrome.runtime.sendMessage({ type: 'get_status' }, (r: GetStatusResponse) => {
        if (chrome.runtime.lastError) {
          if (++attempts > 10) {
            clearInterval(poll);
            // Fall back to a recoverable state so the user can retry.
            applyHealthState('paused');
          }
          return;
        }

        const health = r?.health ?? (r?.connected ? 'connected' : 'connecting');
        if (health === 'connected' || health === 'error' || health === 'auth_required') {
          clearInterval(poll);
          applyHealthState(health as ConnectionHealthState, r?.healthDetail);
        } else if (++attempts > 10) {
          clearInterval(poll);
          // Polling exhausted without reaching a terminal health state.
          // Fall back to paused so the Connect button re-enables and
          // the user can retry instead of being stuck on "Connecting...".
          applyHealthState('paused');
        }
      });
    }, 300);
  });
});

// ── Pause (secondary action) ────────────────────────────────────────
//
// Sends the `pause` message to the worker, which tears down the relay
// WebSocket and clears the `autoConnect` flag. Credentials are
// preserved so the next Connect is instant.

btnPause.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'pause' }, () => {
    applyHealthState('paused');
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
// This is a manual recovery control -- normal connect handles pairing
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
  // survives the popup teardown race -- see the `self-hosted-pair`
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
// This is a manual recovery control -- normal connect handles cloud
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
  // reconnect -- the user is explicitly retrying sign-in now.
  await chrome.storage.local.remove('vellum.relayAuthError');
  // Delegate to the service worker -- see header comment for the rationale.
  const response = await requestCloudSignIn();
  if (response.ok && response.token) {
    setCloudStatus(`Signed in as guardian:${response.token.guardianId}`, true);
  } else {
    setCloudStatus(`Sign-in failed: ${response.error ?? 'Unknown error'}`, false);
  }
  btnCloudSignIn.disabled = false;
});

refreshCloudStatus();
