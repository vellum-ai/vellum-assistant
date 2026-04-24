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
 * Primary control is a single **Connection** toggle. Manual recovery
 * controls (local re-pair) plus the support port
 * override live in a collapsible **Advanced** section that is hidden
 * by default. The section auto-expands when the health state is
 * `auth_required` or `error`, making recovery accessible without
 * cluttering the happy path.
 *
 * On open the popup loads the assistant catalog from the worker via the
 * `assistants-get` message. When exactly one assistant exists it is
 * auto-selected and no selector dropdown is shown. When multiple
 * assistants exist a `<select>` dropdown is rendered in lockfile order.
 *
 * Switching assistants sends an `assistant-select` message to the
 * worker, which persists the selection and returns the resolved
 * descriptor + auth profile. The popup then refreshes the local
 * auth status panels to match the newly selected assistant.
 */


import {
  getStoredLocalToken,
  type StoredLocalToken,
} from '../background/self-hosted-auth.js';
import type { AssistantDescriptor } from '../background/native-host-assistants.js';
import type { AssistantAuthProfile } from '../background/assistant-auth-profile.js';
import {
  deriveSelectorDisplay,
  shouldShowLocalSection,

  deriveSetupMessage,
  deriveHealthStatusDisplay,
  healthToPhase,
  shouldExpandTroubleshooting,
  hasTroubleshootingControls,
  deriveEnvironmentHint,
  type ConnectionHealthState,
  type ConnectionHealthDetail,
  type ConnectionPhase,
  type GetStatusResponse,
  type AssistantsGetResponse,
  type AssistantSelectResponse,
  type EnvironmentStateResponse,
} from './popup-state.js';

// ── DOM references ──────────────────────────────────────────────────

const connectionToggle = document.getElementById('connection-toggle') as HTMLInputElement;
const connectionToggleHint = document.getElementById(
  'connection-toggle-hint',
) as HTMLParagraphElement;
const statusDot = document.getElementById('status-dot') as HTMLDivElement;
const statusText = document.getElementById('status-text') as HTMLParagraphElement;
const statusBadge = document.getElementById('status-badge') as HTMLSpanElement;
const errorText = document.getElementById('error-text') as HTMLParagraphElement;
const debugDetails = document.getElementById('debug-details') as HTMLDivElement;
const debugDetailsText = document.getElementById(
  'debug-details-text',
) as HTMLParagraphElement;
const copyDebugDetailsButton = document.getElementById(
  'copy-debug-details',
) as HTMLButtonElement;
const setupMessage = document.getElementById('setup-message') as HTMLParagraphElement;

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

const environmentSelect = document.getElementById(
  'environment-select',
) as HTMLSelectElement;
const environmentHint = document.getElementById(
  'environment-hint',
) as HTMLParagraphElement;

// ── Current assistant state ─────────────────────────────────────────
//
// Tracks the currently selected assistant and its auth profile so
// connect and auth-refresh operations use the right assistant context.

let currentAssistantId: string | null = null;
let currentAuthProfile: AssistantAuthProfile | null = null;

// ── Current health state ────────────────────────────────────────────
//
// Tracks the latest health state from the worker so the troubleshoot
// section can react to state changes.

let currentHealthState: ConnectionHealthState = 'paused';
let currentDebugDetails: string | null = null;

// ── Current environment state ───────────────────────────────────────
//
// Tracks the build-default environment so the change handler can
// detect when the user re-selects the default and clear the override.

let currentBuildDefaultEnvironment: string | undefined;

// ── Connection phase management ─────────────────────────────────────

/**
 * Show or hide the setup-message element based on the current phase.
 */
function setSetupMessage(phase: ConnectionPhase): void {
  const msg = deriveSetupMessage(phase);
  if (msg) {
    setupMessage.textContent = msg;
    setupMessage.style.display = 'block';
  } else {
    setupMessage.style.display = 'none';
  }
}

function statusBadgeDisplay(health: ConnectionHealthState): {
  text: string;
  className: 'connected' | 'paused' | 'disconnected';
} {
  switch (health) {
    case 'connected':
      return { text: 'Online', className: 'connected' };
    case 'connecting':
      return { text: 'Starting', className: 'paused' };
    case 'reconnecting':
      return { text: 'Recovering', className: 'paused' };
    case 'paused':
      return { text: 'Paused', className: 'paused' };
    case 'auth_required':
      return { text: 'Needs action', className: 'disconnected' };
    case 'error':
      return { text: 'Issue detected', className: 'disconnected' };
  }
}

function connectionHint(phase: ConnectionPhase): string {
  switch (phase) {
    case 'connected':
      return 'On and ready.';
    case 'connecting':
      return 'Starting connection...';
    case 'reconnecting':
      return 'Recovering automatically...';
    case 'paused':
    case 'disconnected':
      return 'Turn on to connect.';
    case 'no-native-host':
      return 'Install the desktop app first.';
  }
}

function isToggleCheckedForPhase(phase: ConnectionPhase): boolean {
  return phase === 'connecting' || phase === 'reconnecting' || phase === 'connected';
}

/**
 * Apply the worker's health state to the full popup UI.
 */
function applyHealthState(
  health: ConnectionHealthState,
  detail?: ConnectionHealthDetail,
): void {
  currentHealthState = health;

  const phase = healthToPhase(health);
  connectionToggle.checked = isToggleCheckedForPhase(phase);
  connectionToggle.disabled = phase === 'connecting' || phase === 'reconnecting';
  connectionToggleHint.textContent = connectionHint(phase);

  // Derive health-aware status display (richer than phase-based).
  const status = deriveHealthStatusDisplay(health, detail);
  statusDot.className = `status-dot ${status.dotClass}`;
  statusText.textContent = status.text;
  const badge = statusBadgeDisplay(health);
  statusBadge.textContent = badge.text;
  statusBadge.className = `status-badge ${badge.className}`;

  setSetupMessage(phase);

  if (health === 'connected') {
    errorText.style.display = 'none';
    hideDebugDetails();
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
  if (phase === 'no-native-host') {
    currentHealthState = 'error';
    connectionToggle.checked = false;
    connectionToggle.disabled = true;
    connectionToggleHint.textContent = connectionHint('no-native-host');
    statusDot.className = 'status-dot disconnected';
    statusText.textContent = 'Desktop app required';
    statusBadge.textContent = 'Needs app';
    statusBadge.className = 'status-badge disconnected';
    setSetupMessage('no-native-host');
    updateTroubleshootSection('error');
    return;
  }

  // Map phase back to a health state for the unified path.
  const healthMap: Record<Exclude<ConnectionPhase, 'no-native-host'>, ConnectionHealthState> = {
    connected: 'connected',
    connecting: 'connecting',
    reconnecting: 'reconnecting',
    disconnected: 'paused',
    paused: 'paused',
  };
  applyHealthState(healthMap[phase]);
}

function hideDebugDetails(): void {
  currentDebugDetails = null;
  debugDetailsText.textContent = '';
  debugDetails.style.display = 'none';
}

function maybeShowDebugDetails(message: string, details?: string): void {
  const traceMatch = message.match(/\[trace=([^\]]+)\]/);
  const traceLine = traceMatch ? `trace_id=${traceMatch[1]}` : null;
  const rendered =
    details && details.trim().length > 0
      ? details.trim()
      : traceLine;

  if (!rendered) {
    hideDebugDetails();
    return;
  }

  currentDebugDetails = rendered;
  debugDetailsText.textContent = rendered;
  debugDetails.style.display = 'block';
}

function showErrorTextWithDebug(msg: string, debugText?: string): void {
  errorText.textContent = msg;
  errorText.style.display = 'block';
  maybeShowDebugDetails(msg, debugText);
}

function showError(msg: string, debugText?: string): void {
  showErrorTextWithDebug(msg, debugText);
}

copyDebugDetailsButton.addEventListener('click', async () => {
  if (!currentDebugDetails) return;
  try {
    await navigator.clipboard.writeText(currentDebugDetails);
    const originalLabel = copyDebugDetailsButton.textContent;
    copyDebugDetailsButton.textContent = 'Copied';
    setTimeout(() => {
      copyDebugDetailsButton.textContent = originalLabel;
    }, 1000);
  } catch (err) {
    showError(
      `Failed to copy debug details: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
});

// ── Advanced section ─────────────────────────────────────────────────

/**
 * Update the Advanced section visibility and expansion state.
 *
 * The section is always shown because it contains support settings.
 * It auto-expands when the health state is `auth_required` or `error`
 * so users can access recovery controls.
 */
function updateTroubleshootSection(health: ConnectionHealthState): void {
  const hasControls = hasTroubleshootingControls(currentAuthProfile);
  troubleshootSection.hidden = false;

  // Auto-expand when action is required, auto-collapse on recovery.
  if (shouldExpandTroubleshooting(health)) {
    expandTroubleshoot();
  } else if (health === 'connected' || !hasControls) {
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
 * Update the visibility of the Local troubleshooting controls
 * based on the selected assistant's auth profile.
 */
function updateAuthSections(authProfile: AssistantAuthProfile | null): void {
  currentAuthProfile = authProfile;
  const showLocal = shouldShowLocalSection(authProfile);

  // Toggle Local troubleshooting elements visibility.
  localStatus.style.display = showLocal ? '' : 'none';
  btnPairLocal.style.display = showLocal ? '' : 'none';

  // Update troubleshoot section with current health state.
  updateTroubleshootSection(currentHealthState);
}

/**
 * Load the assistant catalog from the worker and render the selector.
 */
function isNativeHostMissing(error: string | undefined): boolean {
  if (!error) return false;
  const lower = error.toLowerCase();
  // Match only Chrome's host-not-installed error message:
  //   "Specified native messaging host not found."
  // Recoverable errors, allowlist errors ("forbidden"), generic helper
  // errors, and disconnect-before-response must NOT trigger no-native-host.
  return lower.includes('native messaging host') && lower.includes('not found');
}

function isNativeHostForbidden(error: string | undefined): boolean {
  if (!error) return false;
  const lower = error.toLowerCase();
  return lower.includes('native messaging host') && lower.includes('forbidden');
}

function loadAssistantCatalog(): void {
  chrome.runtime.sendMessage({ type: 'assistants-get' }, (response: AssistantsGetResponse) => {
    if (chrome.runtime.lastError || !response?.ok) {
      const errMsg = response?.error ?? chrome.runtime.lastError?.message ?? 'Failed to load assistants';

      if (isNativeHostMissing(errMsg)) {
        setPhase('no-native-host');
        return;
      }

      if (isNativeHostForbidden(errMsg)) {
        showError(
          'Native host access is blocked for this extension ID. Add the ID to ~/.vellum/chrome-extension-allowlist.local.json, restart the desktop app, then reload the extension.',
        );
        return;
      }

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
  });
}

// Load on popup open.
loadAssistantCatalog();

// ── Assistant selection change ──────────────────────────────────────

assistantSelect.addEventListener('change', () => {
  const assistantId = assistantSelect.value;
  if (!assistantId) return;

  errorText.style.display = 'none';
  hideDebugDetails();

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
    },
  );
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

// ── Connection toggle ────────────────────────────────────────────────
//
// No local precheck -- the worker handles auth bootstrap (pairing/sign-in)
// automatically when interactive=true. Users can connect in one click
// even when not previously paired or signed in.

async function requestConnect(): Promise<void> {
  errorText.style.display = 'none';
  hideDebugDetails();
  setPhase('connecting');

  await new Promise<void>((resolve) => {
    chrome.runtime.sendMessage({ type: 'connect' }, (response: { ok: boolean; error?: string; debugDetails?: string }) => {
      if (chrome.runtime.lastError || !response?.ok) {
        showError(
          response?.error ?? chrome.runtime.lastError?.message ?? 'Unknown error',
          response?.debugDetails,
        );
        applyHealthState('error');
        resolve();
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
              resolve();
            }
            return;
          }

          const health = r?.health ?? (r?.connected ? 'connected' : 'connecting');
          if (health === 'connected' || health === 'error' || health === 'auth_required') {
            clearInterval(poll);
            applyHealthState(health as ConnectionHealthState, r?.healthDetail);
            resolve();
          } else if (++attempts > 10) {
            clearInterval(poll);
            // Polling exhausted without reaching a terminal health state.
            // Fall back to paused so users can retry instead of staying stuck.
            applyHealthState('paused');
            resolve();
          }
        });
      }, 300);
    });
  });
}

// ── Pause ────────────────────────────────────────────────────────────
//
// Sends the `pause` message to the worker, which tears down the relay
// WebSocket and clears the `autoConnect` flag. Credentials are
// preserved so the next Connect is instant.

function requestPause(): void {
  chrome.runtime.sendMessage({ type: 'pause' }, () => {
    applyHealthState('paused');
  });
}

connectionToggle.addEventListener('change', async () => {
  if (connectionToggle.checked) {
    await requestConnect();
    return;
  }
  requestPause();
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
  // handler in worker.ts.
  const response = await requestLocalPair();
  if (response.ok && response.token) {
    setLocalStatus(formatLocalTokenStatus(response.token), 'paired');
  } else {
    setLocalStatus(`Pairing failed: ${response.error ?? 'Unknown error'}`, 'error');
  }
  btnPairLocal.disabled = false;
});

refreshLocalStatus();

// ── Environment selector ────────────────────────────────────────────
//
// The environment dropdown allows developers to override the build-time
// default environment for the current extension profile. This changes
// which API and web URLs are used for pairing and relay.
//
// On popup open we load the effective environment from the worker via
// `environment-get` and render the selected value. On change we persist
// the override via `environment-set`, refresh the assistant catalog and
// auth status, and force a disconnect/reconnect if currently connected.

/**
 * Load environment state from the worker and render the selector.
 */
function loadEnvironmentState(): void {
  chrome.runtime.sendMessage({ type: 'environment-get' }, (response: EnvironmentStateResponse) => {
    if (chrome.runtime.lastError || !response?.ok) return;

    currentBuildDefaultEnvironment = response.buildDefaultEnvironment;

    const effective = response.effectiveEnvironment ?? 'dev';
    environmentSelect.value = effective;
    environmentHint.textContent = deriveEnvironmentHint(
      response.overrideEnvironment,
      response.buildDefaultEnvironment,
    );
  });
}

// Load on popup open.
loadEnvironmentState();

/**
 * Handle environment dropdown changes.
 *
 * Orchestration after environment-set:
 *   1. Refresh assistant catalog (endpoints may have changed).
 *   2. Refresh local auth status panel.
 *   3. If currently connected, disconnect and reconnect so the new
 *      environment-sensitive endpoints take effect immediately.
 */
environmentSelect.addEventListener('change', async () => {
  const newEnv = environmentSelect.value;
  errorText.style.display = 'none';
  hideDebugDetails();

  // When the user selects the build-default environment, clear the
  // override so future bundle updates can change the default without
  // the user staying pinned to a stale value.
  const isDefault = currentBuildDefaultEnvironment != null && newEnv === currentBuildDefaultEnvironment;
  const overrideValue = isDefault ? null : newEnv;

  // Persist the environment override via the worker.
  const response = await new Promise<EnvironmentStateResponse>((resolve) => {
    chrome.runtime.sendMessage(
      { type: 'environment-set', environment: overrideValue },
      (r: EnvironmentStateResponse) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message ?? 'Unknown error' });
          return;
        }
        resolve(r ?? { ok: false, error: 'No response from service worker' });
      },
    );
  });

  if (!response.ok) {
    showError(response.error ?? 'Failed to set environment');
    return;
  }

  // Update the hint to reflect the new state.
  environmentHint.textContent = deriveEnvironmentHint(
    response.overrideEnvironment,
    response.buildDefaultEnvironment,
  );

  // Refresh the assistant catalog — environment change may affect
  // which assistants are available and their auth endpoints.
  loadAssistantCatalog();

  // Refresh auth status panels.
  void refreshLocalStatus();

  // If currently connected, force disconnect then reconnect so the new
  // environment-sensitive endpoints take effect immediately. The worker's
  // `environment-set` handler does NOT auto-reconnect — the popup
  // orchestrates this explicitly.
  if (currentHealthState === 'connected' || currentHealthState === 'connecting' || currentHealthState === 'reconnecting') {
    // Disconnect first.
    await new Promise<void>((resolve) => {
      chrome.runtime.sendMessage({ type: 'pause' }, () => resolve());
    });
    // Reconnect with the new environment.
    await requestConnect();
  }
});
