/**
 * Popup UI for the Vellum browser-relay extension.
 *
 * Manages three screens:
 * 1. Welcome — sign in with Vellum or connect to self-hosted
 * 2. Assistant Picker — choose which cloud assistant to connect to
 * 3. Main — connection status, settings
 *
 * The popup determines the initial screen by asking the worker for
 * the current session state. If a session or self-hosted mode is
 * already configured, it skips straight to Main.
 */

import type { AssistantAuthProfile } from '../background/assistant-auth-profile.js';
import {
  deriveSetupMessage,
  deriveHealthStatusDisplay,
  healthToPhase,
  shouldExpandTroubleshooting,
  hasTroubleshootingControls,
  type ConnectionHealthState,
  type ConnectionHealthDetail,
  type ConnectionPhase,
  type GetStatusResponse,
  type GatewayUrlGetResponse,
} from './popup-state.js';

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Send a message to the service worker with automatic retry.
 *
 * Chrome MV3 service workers may not be awake when the popup first
 * opens. If the message port closes before a response is received
 * (`chrome.runtime.lastError` set, `response` is `undefined`), we
 * retry once after a short delay to give the worker time to wake.
 */
function sendMessage<T>(
  message: Record<string, unknown>,
  callback: (response: T) => void,
  retries = 1,
): void {
  chrome.runtime.sendMessage(message, (response: T) => {
    if (chrome.runtime.lastError && response === undefined && retries > 0) {
      setTimeout(() => sendMessage(message, callback, retries - 1), 200);
      return;
    }
    callback(response);
  });
}

// ── Screens ─────────────────────────────────────────────────────────

const screenWelcome = document.getElementById('screen-welcome') as HTMLDivElement;
const screenPicker = document.getElementById('screen-picker') as HTMLDivElement;
const screenMain = document.getElementById('screen-main') as HTMLDivElement;

type ScreenId = 'welcome' | 'picker' | 'main';

function showScreen(id: ScreenId): void {
  screenWelcome.style.display = id === 'welcome' ? 'block' : 'none';
  screenPicker.style.display = id === 'picker' ? 'block' : 'none';
  screenMain.style.display = id === 'main' ? 'block' : 'none';
}

/** Show the assistants-fetch error state on the main screen. */
function showAssistantsError(detail: string): void {
  assistantsErrorDetailEl.textContent = detail;
  assistantsErrorEl.style.display = 'block';
  connectionAreaEl.style.display = 'none';
}

/** Hide the assistants-fetch error and restore the connection area. */
function hideAssistantsError(): void {
  assistantsErrorEl.style.display = 'none';
  connectionAreaEl.style.display = 'block';
}

// ── DOM references (Main screen) ────────────────────────────────────

const assistantsErrorEl = document.getElementById('assistants-error') as HTMLDivElement;
const assistantsErrorDetailEl = document.getElementById('assistants-error-detail') as HTMLParagraphElement;
const connectionAreaEl = document.getElementById('connection-area') as HTMLDivElement;
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

const gatewayUrlInput = document.getElementById(
  'gateway-url-input',
) as HTMLInputElement;
const gatewayUrlSave = document.getElementById(
  'gateway-url-save',
) as HTMLButtonElement;

const selfHostedSettings = document.getElementById(
  'self-hosted-settings',
) as HTMLDivElement;

// Assistant info bar (cloud mode)
const assistantInfo = document.getElementById('assistant-info') as HTMLDivElement;
const assistantNameEl = document.getElementById('assistant-name') as HTMLParagraphElement;
const assistantAccountEl = document.getElementById('assistant-account') as HTMLParagraphElement;

// Session actions
const sessionActions = document.getElementById('session-actions') as HTMLDivElement;

// ── DOM references (Welcome screen) ─────────────────────────────────

const btnSignIn = document.getElementById('btn-sign-in') as HTMLButtonElement;
const btnSelfHosted = document.getElementById('btn-self-hosted') as HTMLButtonElement;

// ── DOM references (Picker screen) ──────────────────────────────────

const pickerBack = document.getElementById('picker-back') as HTMLButtonElement;
const assistantList = document.getElementById('assistant-list') as HTMLDivElement;
const pickerError = document.getElementById('picker-error') as HTMLParagraphElement;
const pickerLoading = document.getElementById('picker-loading') as HTMLParagraphElement;

// ── Current state ───────────────────────────────────────────────────

let currentAuthProfile: AssistantAuthProfile | null = null;
let _currentHealthState: ConnectionHealthState = 'paused';
let currentDebugDetails: string | null = null;

/** Tracks whether the user has an established mode (self-hosted or cloud). */
let currentMode: 'self-hosted' | 'cloud' | null = null;

// ── Connection phase management ─────────────────────────────────────

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

function updateHealthDisplay(
  health: ConnectionHealthState,
  detail: ConnectionHealthDetail,
): void {
  _currentHealthState = health;
  const phase = healthToPhase(health);

  // Status dot + text
  const display = deriveHealthStatusDisplay(health, detail);
  statusDot.className = `status-dot ${display.dotClass}`;
  statusText.textContent = display.text;

  // Badge
  const badge = statusBadgeDisplay(health);
  statusBadge.textContent = badge.text;
  statusBadge.className = `status-badge ${badge.className}`;

  // Error text
  if (detail?.lastErrorMessage && (health === 'auth_required' || health === 'error')) {
    errorText.textContent = detail.lastErrorMessage;
    errorText.style.display = 'block';
  } else {
    errorText.style.display = 'none';
  }

  // Debug details
  if (detail?.lastErrorMessage && (health === 'auth_required' || health === 'error')) {
    currentDebugDetails = detail.lastErrorMessage;
    debugDetailsText.textContent = detail.lastErrorMessage;
    debugDetails.style.display = 'block';
  } else {
    currentDebugDetails = null;
    debugDetails.style.display = 'none';
  }

  // Setup message
  setSetupMessage(phase);

  // Troubleshoot section
  if (shouldExpandTroubleshooting(health)) {
    troubleshootBody.style.display = 'block';
    troubleshootToggle.setAttribute('aria-expanded', 'true');
  }

  // Show/hide troubleshoot controls
  if (hasTroubleshootingControls(currentAuthProfile)) {
    troubleshootSection.style.display = 'block';
  } else {
    troubleshootSection.style.display = 'none';
  }
}

// ── Main screen mode-specific visibility ────────────────────────────

function applyMainScreenMode(): void {
  if (currentMode === 'cloud') {
    selfHostedSettings.style.display = 'none';
    assistantInfo.style.display = 'flex';
    sessionActions.style.display = 'flex';
  } else {
    // self-hosted
    selfHostedSettings.style.display = 'block';
    assistantInfo.style.display = 'none';
    sessionActions.style.display = 'none';
  }
}

// ── Gateway URL ─────────────────────────────────────────────────────

function loadGatewayUrl(): void {
  sendMessage<GatewayUrlGetResponse>({ type: 'gateway-url-get' }, (response) => {
    if (response?.ok && response.gatewayUrl) {
      gatewayUrlInput.value = response.gatewayUrl;
    }
  });
}

gatewayUrlSave?.addEventListener('click', () => {
  const url = gatewayUrlInput.value.trim();
  if (!url) return;
  gatewayUrlSave.disabled = true;
  gatewayUrlSave.textContent = 'Saving\u2026';
  sendMessage(
    { type: 'gateway-url-set', gatewayUrl: url },
    () => {
      gatewayUrlSave.disabled = false;
      gatewayUrlSave.textContent = 'Save';
    },
  );
});

// Also save on Enter key in the URL input
gatewayUrlInput?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    gatewayUrlSave?.click();
  }
});

// ── Re-pair button ──────────────────────────────────────────────────

btnPairLocal?.addEventListener('click', () => {
  localStatus.textContent = 'Pairing\u2026';
  sendMessage<{ ok: boolean; error?: string }>(
    { type: 'self-hosted-pair' },
    (response) => {
      if (response?.ok) {
        localStatus.textContent = 'Paired successfully';
      } else {
        localStatus.textContent = `Pair failed: ${response?.error ?? 'unknown error'}`;
      }
    },
  );
});

// ── Copy debug details ──────────────────────────────────────────────

copyDebugDetailsButton?.addEventListener('click', async () => {
  if (!currentDebugDetails) return;
  try {
    await navigator.clipboard.writeText(currentDebugDetails);
    copyDebugDetailsButton.textContent = 'Copied!';
    setTimeout(() => {
      copyDebugDetailsButton.textContent = 'Copy';
    }, 1500);
  } catch {
    // Clipboard API may fail in some contexts; ignore.
  }
});

// ── Troubleshoot toggle ─────────────────────────────────────────────

troubleshootToggle?.addEventListener('click', () => {
  const isExpanded = troubleshootToggle.getAttribute('aria-expanded') === 'true';
  troubleshootToggle.setAttribute('aria-expanded', String(!isExpanded));
  troubleshootBody.style.display = isExpanded ? 'none' : 'block';
});

// ── Welcome screen handlers ─────────────────────────────────────────

btnSignIn?.addEventListener('click', () => {
  btnSignIn.disabled = true;
  btnSignIn.textContent = 'Signing in\u2026';
  sendMessage<{
    ok: boolean;
    session?: { email: string };
    assistants?: Array<{ id: string; name: string }>;
    assistantsError?: string;
    error?: string;
  }>({ type: 'cloud-login' }, (response) => {
    btnSignIn.disabled = false;
    btnSignIn.textContent = 'Sign in with Vellum';

    if (!response?.ok) {
      // Show inline error on welcome screen — keep it simple
      const err = response?.error ?? 'Login failed';
      // Re-use the welcome-subtitle to show the error briefly
      const subtitle = screenWelcome.querySelector('.welcome-subtitle');
      if (subtitle) {
        subtitle.textContent = err;
        subtitle.classList.add('error-text');
        setTimeout(() => {
          subtitle.textContent = 'Bridge your browser to your personal assistant.';
          subtitle.classList.remove('error-text');
        }, 4000);
      }
      return;
    }

    // If assistant fetch failed, show error state on main screen
    // (user is logged in, so show email + sign out)
    if (response.assistantsError) {
      currentMode = 'cloud';
      if (response.session?.email) {
        assistantAccountEl.textContent = response.session.email;
      }
      applyMainScreenMode();
      showAssistantsError(response.assistantsError);
      showScreen('main');
      return;
    }

    const assistants = response.assistants ?? [];
    if (assistants.length === 1) {
      // Single assistant — select it directly and go to main
      selectAssistant(assistants[0].id, assistants[0].name, response.session?.email);
    } else if (assistants.length > 1) {
      // Multiple assistants — show picker
      renderAssistantList(assistants, response.session?.email);
      showScreen('picker');
    } else {
      // No assistants — go to main in cloud mode with no assistant selected yet
      currentMode = 'cloud';
      if (response.session?.email) {
        assistantAccountEl.textContent = response.session.email;
      }
      applyMainScreenMode();
      showScreen('main');
      loadMainScreen();
    }
  });
});

btnSelfHosted?.addEventListener('click', () => {
  currentMode = 'self-hosted';
  sendMessage({ type: 'set-mode', mode: 'self-hosted' }, () => {});
  applyMainScreenMode();
  showScreen('main');
  loadMainScreen();
});

// ── Picker screen handlers ──────────────────────────────────────────

pickerBack?.addEventListener('click', () => {
  showScreen('welcome');
});

function renderAssistantList(
  assistants: Array<{ id: string; name: string }>,
  email?: string,
): void {
  pickerLoading.style.display = 'none';
  pickerError.style.display = 'none';
  assistantList.innerHTML = '';

  for (const a of assistants) {
    const row = document.createElement('div');
    row.className = 'assistant-row';
    row.innerHTML = `
      <div class="assistant-row-icon">
        <img src="../icons/icon48.png" alt="" width="16" height="16" style="border-radius:3px;" />
      </div>
      <span class="assistant-row-name">${escapeHtml(a.name)}</span>
      <svg class="assistant-row-arrow" width="12" height="12" viewBox="0 0 12 12" fill="none">
        <path d="M4 2L8 6L4 10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    `;
    row.addEventListener('click', () => selectAssistant(a.id, a.name, email));
    assistantList.appendChild(row);
  }
}

function selectAssistant(id: string, name: string, email?: string): void {
  currentMode = 'cloud';
  assistantNameEl.textContent = name;
  assistantAccountEl.textContent = email ?? '';

  sendMessage({ type: 'select-assistant', assistantId: id, assistantName: name }, () => {});
  applyMainScreenMode();
  showScreen('main');
  loadMainScreen();
}

// ── Sign out ────────────────────────────────────────────────────────

document.getElementById('btn-sign-out')?.addEventListener('click', () => {
  sendMessage({ type: 'cloud-logout' }, () => {
    currentMode = null;
    hideAssistantsError();
    showScreen('welcome');
  });
});

document.getElementById('btn-retry-assistants')?.addEventListener('click', () => {
  // Re-trigger cloud-login to retry the full flow
  hideAssistantsError();
  sendMessage<{
    ok: boolean;
    session?: { email: string };
    assistants?: Array<{ id: string; name: string }>;
    assistantsError?: string;
    error?: string;
  }>({ type: 'cloud-login' }, (response) => {
    if (!response?.ok) {
      showAssistantsError(response?.error ?? 'Login failed');
      return;
    }
    if (response.assistantsError) {
      showAssistantsError(response.assistantsError);
      return;
    }
    const assistants = response.assistants ?? [];
    if (assistants.length === 1) {
      selectAssistant(assistants[0].id, assistants[0].name, response.session?.email);
    } else if (assistants.length > 1) {
      renderAssistantList(assistants, response.session?.email);
      showScreen('picker');
    } else {
      applyMainScreenMode();
      loadMainScreen();
    }
  });
});

// ── Main screen initialization ──────────────────────────────────────

/** Poll interval for refreshing connection status while the popup is open. */
const STATUS_POLL_INTERVAL_MS = 2_000;
let statusPollTimer: ReturnType<typeof setInterval> | null = null;

function loadMainScreen(): void {
  loadGatewayUrl();
  // Auto-connect if not already connected — the extension manages
  // the connection lifecycle without a manual toggle.
  sendMessage({ type: 'connect' }, () => {});
  refreshStatus();
  startStatusPoll();
}

function refreshStatus(): void {
  sendMessage<GetStatusResponse>({ type: 'get_status' }, (response) => {
    if (!response) return;
    currentAuthProfile = response.authProfile;
    updateHealthDisplay(response.health, response.healthDetail);
  });
}

function startStatusPoll(): void {
  if (statusPollTimer) return;
  statusPollTimer = setInterval(refreshStatus, STATUS_POLL_INTERVAL_MS);
}

// ── HTML escaping ───────────────────────────────────────────────────

function escapeHtml(str: string): string {
  const el = document.createElement('span');
  el.textContent = str;
  return el.innerHTML;
}

// ── Initial load ────────────────────────────────────────────────────
//
// Ask the worker whether a session / mode is already established.
// If so, skip welcome and go straight to main.

sendMessage<{
  ok: boolean;
  mode: 'self-hosted' | 'cloud' | null;
  session?: { email: string } | null;
  selectedAssistant?: { id: string; name: string } | null;
}>({ type: 'get-session' }, (response) => {
  if (!response?.ok) {
    showScreen('welcome');
    return;
  }

  if (response.mode === 'self-hosted') {
    currentMode = 'self-hosted';
    applyMainScreenMode();
    showScreen('main');
    loadMainScreen();
  } else if (response.mode === 'cloud') {
    currentMode = 'cloud';
    if (response.selectedAssistant) {
      assistantNameEl.textContent = response.selectedAssistant.name;
    }
    if (response.session?.email) {
      assistantAccountEl.textContent = response.session.email;
    }
    applyMainScreenMode();
    showScreen('main');
    loadMainScreen();
  } else {
    showScreen('welcome');
  }
});
