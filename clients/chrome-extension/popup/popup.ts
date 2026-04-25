/**
 * Popup UI for the Vellum browser-relay extension.
 *
 * The popup renders a concise primary status derived from the worker's
 * structured connection health state. The user configures a self-hosted
 * gateway URL (defaulted to http://127.0.0.1:7830) and toggles connection
 * on/off. Manual recovery controls (re-pair) and the environment selector
 * live in a collapsible Advanced section.
 */

import type { AssistantAuthProfile } from '../background/assistant-auth-profile.js';
import {
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
  type GatewayUrlGetResponse,
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

const gatewayUrlInput = document.getElementById(
  'gateway-url-input',
) as HTMLInputElement;
const gatewayUrlSave = document.getElementById(
  'gateway-url-save',
) as HTMLButtonElement;

const environmentSelect = document.getElementById(
  'environment-select',
) as HTMLSelectElement;
const environmentHint = document.getElementById(
  'environment-hint',
) as HTMLParagraphElement;

// ── Current state ───────────────────────────────────────────────────

let currentAuthProfile: AssistantAuthProfile | null = null;
let currentHealthState: ConnectionHealthState = 'paused';
let currentDebugDetails: string | null = null;
let currentBuildDefaultEnvironment: string | undefined;

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
  currentHealthState = health;
  const phase = healthToPhase(health);

  // Status dot + text
  const display = deriveHealthStatusDisplay(health, detail);
  statusDot.className = `status-dot ${display.dotClass}`;
  statusText.textContent = display.text;

  // Badge
  const badge = statusBadgeDisplay(health);
  statusBadge.textContent = badge.text;
  statusBadge.className = `status-badge ${badge.className}`;

  // Toggle state
  connectionToggle.checked = health === 'connected' || health === 'connecting' || health === 'reconnecting';
  connectionToggle.disabled = health === 'connecting' || health === 'reconnecting';

  // Toggle hint
  connectionToggleHint.textContent =
    health === 'connected'
      ? 'Extension is bridging browser actions'
      : health === 'paused'
        ? 'Turn on to start relaying'
        : health === 'connecting' || health === 'reconnecting'
          ? 'Establishing connection\u2026'
          : 'Turn on to connect';

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

// ── Gateway URL ─────────────────────────────────────────────────────

function loadGatewayUrl(): void {
  chrome.runtime.sendMessage({ type: 'gateway-url-get' }, (response: GatewayUrlGetResponse) => {
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
  chrome.runtime.sendMessage(
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

// ── Connection toggle ───────────────────────────────────────────────

connectionToggle.addEventListener('change', () => {
  if (connectionToggle.checked) {
    chrome.runtime.sendMessage({ type: 'connect' });
  } else {
    chrome.runtime.sendMessage({ type: 'pause' });
  }
});

// ── Re-pair button ──────────────────────────────────────────────────

btnPairLocal?.addEventListener('click', () => {
  localStatus.textContent = 'Pairing\u2026';
  chrome.runtime.sendMessage(
    { type: 'self-hosted-pair' },
    (response: { ok: boolean; error?: string }) => {
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

// ── Environment selector ────────────────────────────────────────────

function loadEnvironment(): void {
  chrome.runtime.sendMessage({ type: 'environment-get' }, (response: EnvironmentStateResponse) => {
    if (!response?.ok) return;
    currentBuildDefaultEnvironment = response.buildDefaultEnvironment;
    if (response.overrideEnvironment) {
      environmentSelect.value = response.overrideEnvironment;
    } else if (response.buildDefaultEnvironment) {
      environmentSelect.value = response.buildDefaultEnvironment;
    }
    environmentHint.textContent = deriveEnvironmentHint(
      response.overrideEnvironment,
      response.buildDefaultEnvironment,
    );
  });
}

environmentSelect?.addEventListener('change', () => {
  const value = environmentSelect.value;
  const isDefault = value === currentBuildDefaultEnvironment;
  chrome.runtime.sendMessage(
    { type: 'environment-set', environment: isDefault ? null : value },
    (response: EnvironmentStateResponse) => {
      if (response?.ok) {
        environmentHint.textContent = deriveEnvironmentHint(
          response.overrideEnvironment,
          response.buildDefaultEnvironment,
        );
      }
    },
  );
});

// ── Initial load ────────────────────────────────────────────────────

function refreshStatus(): void {
  chrome.runtime.sendMessage({ type: 'get_status' }, (response: GetStatusResponse) => {
    if (!response) return;
    currentAuthProfile = response.authProfile;
    updateHealthDisplay(response.health, response.healthDetail);
  });
}

loadGatewayUrl();
loadEnvironment();
refreshStatus();
