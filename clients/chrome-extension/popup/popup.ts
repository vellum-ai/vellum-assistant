/**
 * Popup UI for the Vellum browser-relay extension.
 *
 * Manages five screens:
 * 1. Welcome — sign in with Vellum or connect to self-hosted
 * 2. Assistant Picker — choose which cloud assistant to connect to
 * 3. Main — connection status, activity card, settings
 * 4. Activity — list of browser operations (one row per request/response pair)
 * 5. Detail — request/response tabs for a single operation
 *
 * The popup determines the initial screen by asking the worker for
 * the current session state. If a session or self-hosted mode is
 * already configured, it skips straight to Main.
 */

import type { AssistantAuthProfile } from '../background/assistant-auth-profile.js';
import type { OperationEntry } from '../background/event-log.js';
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
const screenActivity = document.getElementById('screen-activity') as HTMLDivElement;
const screenDetail = document.getElementById('screen-detail') as HTMLDivElement;

type ScreenId = 'welcome' | 'picker' | 'main' | 'activity' | 'detail';

function showScreen(id: ScreenId): void {
  screenWelcome.style.display = id === 'welcome' ? 'block' : 'none';
  screenPicker.style.display = id === 'picker' ? 'block' : 'none';
  screenMain.style.display = id === 'main' ? 'block' : 'none';
  screenActivity.style.display = id === 'activity' ? 'block' : 'none';
  screenDetail.style.display = id === 'detail' ? 'block' : 'none';
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

// Activity card
const activityCard = document.getElementById('activity-card') as HTMLDivElement;
const activityCount = document.getElementById('activity-count') as HTMLSpanElement;

// ── DOM references (Activity screen) ────────────────────────────────

const activityBack = document.getElementById('activity-back') as HTMLButtonElement;
const activityListEl = document.getElementById('activity-list') as HTMLDivElement;
const activityEmpty = document.getElementById('activity-empty') as HTMLParagraphElement;

// ── DOM references (Detail screen) ──────────────────────────────────

const detailBack = document.getElementById('detail-back') as HTMLButtonElement;
const detailOperationName = document.getElementById('detail-operation-name') as HTMLParagraphElement;
const detailMeta = document.getElementById('detail-meta') as HTMLParagraphElement;
const detailTabRequest = document.getElementById('detail-tab-request') as HTMLButtonElement;
const detailTabResponse = document.getElementById('detail-tab-response') as HTMLButtonElement;
const detailPanelRequest = document.getElementById('detail-panel-request') as HTMLDivElement;
const detailPanelResponse = document.getElementById('detail-panel-response') as HTMLDivElement;
const detailRequestContent = document.getElementById('detail-request-content') as HTMLPreElement;
const detailResponseContent = document.getElementById('detail-response-content') as HTMLPreElement;

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

/** Cached operations for the activity list. */
let cachedOperations: OperationEntry[] = [];

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
    case 'assistant_gone':
      return { text: 'Assistant removed', className: 'disconnected' };
    case 'error':
      return { text: 'Issue detected', className: 'disconnected' };
  }
}

function updateHealthDisplay(
  health: ConnectionHealthState,
  detail: ConnectionHealthDetail,
): void {
  // If the assistant was retired/deleted, show the picker screen so
  // the user can select a new one. The worker already stopped the SSE
  // loop — the popup just needs to navigate.
  if (health === 'assistant_gone' && _currentHealthState !== 'assistant_gone') {
    showScreen('picker');
    refreshAssistantPicker();
  }

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
  const signOutBtn = document.getElementById('btn-sign-out') as HTMLButtonElement;
  if (currentMode === 'cloud') {
    selfHostedSettings.style.display = 'none';
    assistantInfo.style.display = 'flex';
    sessionActions.style.display = 'flex';
    signOutBtn.textContent = 'Sign out';
  } else {
    // self-hosted
    selfHostedSettings.style.display = 'block';
    assistantInfo.style.display = 'none';
    sessionActions.style.display = 'flex';
    signOutBtn.textContent = 'Disconnect';
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

// ── Activity card → Activity screen ─────────────────────────────────

activityCard?.addEventListener('click', () => {
  refreshOperations(() => {
    showScreen('activity');
  });
});

activityBack?.addEventListener('click', () => {
  showScreen('main');
});

// ── Operations ──────────────────────────────────────────────────────

function refreshOperations(callback?: () => void): void {
  sendMessage<{ ok: boolean; operations: OperationEntry[] }>(
    { type: 'get-operations' },
    (response) => {
      if (!response?.ok) {
        callback?.();
        return;
      }
      cachedOperations = response.operations;
      renderActivityList();
      callback?.();
    },
  );
}

function refreshActivityCount(): void {
  sendMessage<{ ok: boolean; operations: OperationEntry[] }>(
    { type: 'get-operations' },
    (response) => {
      if (!response?.ok) return;
      cachedOperations = response.operations;
      activityCount.textContent = String(response.operations.length);
    },
  );
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function renderActivityList(): void {
  // Clear existing rows
  const existingRows = activityListEl.querySelectorAll('.activity-row');
  existingRows.forEach((r) => r.remove());

  if (cachedOperations.length === 0) {
    activityEmpty.style.display = 'block';
    return;
  }
  activityEmpty.style.display = 'none';

  // Render newest first
  for (let i = cachedOperations.length - 1; i >= 0; i--) {
    const op = cachedOperations[i]!;
    const row = document.createElement('div');
    row.className = 'activity-row';
    row.dataset.operationId = String(op.id);

    const iconClass = op.respondedAt
      ? op.isError ? 'error' : 'success'
      : 'pending';
    const iconSymbol = op.respondedAt
      ? op.isError ? '✗' : '✓'
      : '⋯';

    const durationText = op.durationMs != null
      ? ` · ${formatDuration(op.durationMs)}`
      : '';

    row.innerHTML = [
      `<div class="activity-row-icon ${iconClass}">${iconSymbol}</div>`,
      `<div class="activity-row-body">`,
      `  <p class="activity-row-name">${escapeHtml(op.operationName)}</p>`,
      `  <p class="activity-row-meta">${escapeHtml(formatTime(op.requestedAt))}${durationText}</p>`,
      `</div>`,
      `<svg class="activity-row-arrow" width="12" height="12" viewBox="0 0 12 12" fill="none">`,
      `  <path d="M4 2L8 6L4 10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`,
      `</svg>`,
    ].join('');

    row.addEventListener('click', () => showOperationDetail(op));
    activityListEl.appendChild(row);
  }
}

// ── Operation detail ────────────────────────────────────────────────

function showOperationDetail(op: OperationEntry): void {
  detailOperationName.textContent = op.operationName;

  const parts: string[] = [formatTime(op.requestedAt)];
  if (op.durationMs != null) {
    parts.push(formatDuration(op.durationMs));
  }
  if (op.isError) {
    parts.push('Error');
  }
  detailMeta.textContent = parts.join(' · ');

  // Request content
  if (op.request) {
    detailRequestContent.textContent = JSON.stringify(op.request, null, 2);
  } else {
    detailRequestContent.textContent = 'No request data available';
  }

  // Response content
  if (op.responseContent) {
    try {
      const parsed = JSON.parse(op.responseContent);
      detailResponseContent.textContent = JSON.stringify(parsed, null, 2);
    } catch {
      detailResponseContent.textContent = op.responseContent;
    }
  } else if (op.respondedAt) {
    detailResponseContent.textContent = 'Empty response';
  } else {
    detailResponseContent.textContent = 'Awaiting response…';
  }

  // Reset to request tab
  switchDetailTab('request');
  showScreen('detail');
}

function switchDetailTab(tab: 'request' | 'response'): void {
  detailTabRequest.className = `detail-tab${tab === 'request' ? ' active' : ''}`;
  detailTabResponse.className = `detail-tab${tab === 'response' ? ' active' : ''}`;
  detailPanelRequest.style.display = tab === 'request' ? 'block' : 'none';
  detailPanelResponse.style.display = tab === 'response' ? 'block' : 'none';
}

detailTabRequest?.addEventListener('click', () => switchDetailTab('request'));
detailTabResponse?.addEventListener('click', () => switchDetailTab('response'));

detailBack?.addEventListener('click', () => {
  showScreen('activity');
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

/**
 * Non-interactively refresh the assistants list and render the picker.
 * Used when the worker reports assistant_gone — avoids the interactive
 * OAuth flow that cloud-login would trigger.
 */
function refreshAssistantPicker(): void {
  pickerLoading.style.display = 'block';
  pickerError.style.display = 'none';
  assistantList.innerHTML = '';

  sendMessage<{
    ok: boolean;
    assistants?: Array<{ id: string; name: string }>;
    error?: string;
  }>({ type: 'list-assistants' }, (response) => {
    pickerLoading.style.display = 'none';
    if (!response?.ok || !response.assistants) {
      pickerError.textContent = response?.error ?? 'Could not load assistants.';
      pickerError.style.display = 'block';
      return;
    }
    const assistants = response.assistants;
    if (assistants.length === 0) {
      pickerError.textContent = 'No assistants found.';
      pickerError.style.display = 'block';
      return;
    }
    renderAssistantList(assistants, currentAuthProfile === 'vellum-cloud' ? assistantAccountEl.textContent ?? undefined : undefined);
  });
}

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
  if (currentMode === 'self-hosted') {
    sendMessage({ type: 'self-hosted-disconnect' }, () => {
      currentMode = null;
      showScreen('welcome');
    });
  } else {
    sendMessage({ type: 'cloud-logout' }, () => {
      currentMode = null;
      hideAssistantsError();
      showScreen('welcome');
    });
  }
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
  refreshActivityCount();
  startStatusPoll();
}

function refreshStatus(): void {
  sendMessage<GetStatusResponse>({ type: 'get_status' }, (response) => {
    if (!response) return;
    currentAuthProfile = response.authProfile;
    updateHealthDisplay(response.health, response.healthDetail);
  });
  // Update activity count on each status poll too
  refreshActivityCount();
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
