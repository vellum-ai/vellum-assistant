/**
 * Unit tests for popup-state.ts view-state helpers.
 *
 * Exercises the pure display-logic functions without a Chrome runtime:
 *   - deriveSelectorDisplay: hidden for 0/1 assistants, visible for 2+
 *   - assistantLabel: readable label derivation
 *   - shouldShowLocalSection / shouldShowCloudSection: auth-profile gating
 *   - deriveCtaState: CTA label/enablement for each connection phase
 *   - deriveStatusDisplay: status dot class and text for each phase
 *   - healthToPhase: mapping from ConnectionHealthState to ConnectionPhase
 *   - deriveHealthStatusDisplay: health-aware status display with detail
 *   - shouldExpandTroubleshooting: troubleshoot section auto-expand rules
 *   - hasTroubleshootingControls: whether auth controls exist for profile
 */

import { describe, test, expect } from 'bun:test';

import {
  deriveSelectorDisplay,
  assistantLabel,
  shouldShowLocalSection,
  shouldShowCloudSection,
  deriveCtaState,
  deriveStatusDisplay,
  healthToPhase,
  deriveHealthStatusDisplay,
  shouldExpandTroubleshooting,
  hasTroubleshootingControls,
  type ConnectionPhase,
  type ConnectionHealthState,
  type ConnectionHealthDetail,
} from './popup-state.js';

import type { AssistantDescriptor } from '../background/native-host-assistants.js';

// ── Fixtures ───────────────────────────────────────────────────────

function makeDescriptor(
  overrides: Partial<AssistantDescriptor> & { assistantId: string },
): AssistantDescriptor {
  return {
    cloud: 'local',
    runtimeUrl: '',
    daemonPort: undefined,
    isActive: true,
    authProfile: 'local-pair',
    ...overrides,
  };
}

const localAssistant = makeDescriptor({ assistantId: 'my-local-assistant' });
const cloudAssistant = makeDescriptor({
  assistantId: 'my-cloud-assistant',
  cloud: 'vellum',
  runtimeUrl: 'https://runtime.vellum.ai',
  authProfile: 'cloud-oauth',
});
const secondLocal = makeDescriptor({ assistantId: 'second-local' });

function makeDetail(overrides?: Partial<ConnectionHealthDetail>): ConnectionHealthDetail {
  return {
    lastChangeAt: Date.now(),
    ...overrides,
  };
}

// ── deriveSelectorDisplay ──────────────────────────────────────────

describe('deriveSelectorDisplay', () => {
  test('returns hidden when assistant list is empty', () => {
    const result = deriveSelectorDisplay([], null);
    expect(result.kind).toBe('hidden');
  });

  test('returns hidden when exactly one assistant exists', () => {
    const result = deriveSelectorDisplay([localAssistant], localAssistant);
    expect(result.kind).toBe('hidden');
  });

  test('returns visible with options when two or more assistants exist', () => {
    const result = deriveSelectorDisplay(
      [localAssistant, cloudAssistant],
      localAssistant,
    );
    expect(result.kind).toBe('visible');
    if (result.kind !== 'visible') throw new Error('unreachable');

    expect(result.options.length).toBe(2);
    expect(result.options[0]!.assistantId).toBe('my-local-assistant');
    expect(result.options[1]!.assistantId).toBe('my-cloud-assistant');
    expect(result.selectedId).toBe('my-local-assistant');
  });

  test('pre-selects the resolved selected assistant', () => {
    const result = deriveSelectorDisplay(
      [localAssistant, cloudAssistant],
      cloudAssistant,
    );
    if (result.kind !== 'visible') throw new Error('unreachable');
    expect(result.selectedId).toBe('my-cloud-assistant');
  });

  test('defaults to first assistant when selected is null', () => {
    const result = deriveSelectorDisplay(
      [localAssistant, cloudAssistant],
      null,
    );
    if (result.kind !== 'visible') throw new Error('unreachable');
    expect(result.selectedId).toBe('my-local-assistant');
  });

  test('preserves lockfile order in options', () => {
    const result = deriveSelectorDisplay(
      [cloudAssistant, localAssistant, secondLocal],
      cloudAssistant,
    );
    if (result.kind !== 'visible') throw new Error('unreachable');
    expect(result.options[0]!.assistantId).toBe('my-cloud-assistant');
    expect(result.options[1]!.assistantId).toBe('my-local-assistant');
    expect(result.options[2]!.assistantId).toBe('second-local');
  });
});

// ── assistantLabel ────────────────────────────────────────────────

describe('assistantLabel', () => {
  test('returns assistantId as label', () => {
    expect(assistantLabel(localAssistant)).toBe('my-local-assistant');
  });

  test('returns assistantId for cloud assistant', () => {
    expect(assistantLabel(cloudAssistant)).toBe('my-cloud-assistant');
  });
});

// ── shouldShowLocalSection / shouldShowCloudSection ────────────────

describe('shouldShowLocalSection', () => {
  test('returns true for local-pair profile', () => {
    expect(shouldShowLocalSection('local-pair')).toBe(true);
  });

  test('returns false for cloud-oauth profile', () => {
    expect(shouldShowLocalSection('cloud-oauth')).toBe(false);
  });

  test('returns false for unsupported profile', () => {
    expect(shouldShowLocalSection('unsupported')).toBe(false);
  });

  test('returns false for null profile', () => {
    expect(shouldShowLocalSection(null)).toBe(false);
  });
});

describe('shouldShowCloudSection', () => {
  test('returns true for cloud-oauth profile', () => {
    expect(shouldShowCloudSection('cloud-oauth')).toBe(true);
  });

  test('returns false for local-pair profile', () => {
    expect(shouldShowCloudSection('local-pair')).toBe(false);
  });

  test('returns false for unsupported profile', () => {
    expect(shouldShowCloudSection('unsupported')).toBe(false);
  });

  test('returns false for null profile', () => {
    expect(shouldShowCloudSection(null)).toBe(false);
  });
});

// ── deriveCtaState ─────────────────────────────────────────────────

describe('deriveCtaState', () => {
  test('disconnected: Connect enabled, Pause disabled', () => {
    const state = deriveCtaState('disconnected');
    expect(state.connectLabel).toBe('Connect');
    expect(state.connectEnabled).toBe(true);
    expect(state.pauseLabel).toBe('Pause');
    expect(state.pauseEnabled).toBe(false);
  });

  test('connecting: shows Connecting\u2026 label, both buttons disabled', () => {
    const state = deriveCtaState('connecting');
    expect(state.connectLabel).toBe('Connecting\u2026');
    expect(state.connectEnabled).toBe(false);
    expect(state.pauseLabel).toBe('Pause');
    expect(state.pauseEnabled).toBe(false);
  });

  test('connected: Connect disabled, Pause enabled', () => {
    const state = deriveCtaState('connected');
    expect(state.connectLabel).toBe('Connect');
    expect(state.connectEnabled).toBe(false);
    expect(state.pauseLabel).toBe('Pause');
    expect(state.pauseEnabled).toBe(true);
  });

  test('paused: Connect enabled, Pause disabled (same as disconnected)', () => {
    const state = deriveCtaState('paused');
    expect(state.connectLabel).toBe('Connect');
    expect(state.connectEnabled).toBe(true);
    expect(state.pauseLabel).toBe('Pause');
    expect(state.pauseEnabled).toBe(false);
  });

  test('reconnecting: shows Reconnecting\u2026 label, both buttons disabled', () => {
    const state = deriveCtaState('reconnecting');
    expect(state.connectLabel).toBe('Reconnecting\u2026');
    expect(state.connectEnabled).toBe(false);
    expect(state.pauseLabel).toBe('Pause');
    expect(state.pauseEnabled).toBe(false);
  });

  test('all phases produce consistent label/enablement pairs', () => {
    const phases: ConnectionPhase[] = ['disconnected', 'connecting', 'reconnecting', 'connected', 'paused'];
    for (const phase of phases) {
      const state = deriveCtaState(phase);
      // Pause should only be enabled when connected
      expect(state.pauseEnabled).toBe(phase === 'connected');
      // Connect should be disabled when connecting, reconnecting, or connected
      expect(state.connectEnabled).toBe(
        phase !== 'connecting' && phase !== 'reconnecting' && phase !== 'connected',
      );
    }
  });
});

// ── deriveStatusDisplay ────────────────────────────────────────────

describe('deriveStatusDisplay', () => {
  test('disconnected: red dot, Not connected', () => {
    const status = deriveStatusDisplay('disconnected');
    expect(status.dotClass).toBe('disconnected');
    expect(status.text).toBe('Not connected');
  });

  test('connecting: red dot, Connecting\u2026', () => {
    const status = deriveStatusDisplay('connecting');
    expect(status.dotClass).toBe('disconnected');
    expect(status.text).toBe('Connecting\u2026');
  });

  test('reconnecting: amber dot, Reconnecting automatically\u2026', () => {
    const status = deriveStatusDisplay('reconnecting');
    expect(status.dotClass).toBe('paused');
    expect(status.text).toBe('Reconnecting automatically\u2026');
  });

  test('connected: green dot, Connected to relay server', () => {
    const status = deriveStatusDisplay('connected');
    expect(status.dotClass).toBe('connected');
    expect(status.text).toBe('Connected to relay server');
  });

  test('paused: amber dot, Paused', () => {
    const status = deriveStatusDisplay('paused');
    expect(status.dotClass).toBe('paused');
    expect(status.text).toBe('Paused');
  });

  test('display transitions: disconnected -> connecting -> connected -> reconnecting -> connected -> paused -> disconnected', () => {
    const transitions: ConnectionPhase[] = [
      'disconnected',
      'connecting',
      'connected',
      'reconnecting',
      'connected',
      'paused',
      'disconnected',
    ];
    const expectedDots = ['disconnected', 'disconnected', 'connected', 'paused', 'connected', 'paused', 'disconnected'];
    const expectedTexts = [
      'Not connected',
      'Connecting\u2026',
      'Connected to relay server',
      'Reconnecting automatically\u2026',
      'Connected to relay server',
      'Paused',
      'Not connected',
    ];

    for (let i = 0; i < transitions.length; i++) {
      const status = deriveStatusDisplay(transitions[i]!);
      expect(status.dotClass).toBe(expectedDots[i]);
      expect(status.text).toBe(expectedTexts[i]);
    }
  });
});

// ── healthToPhase ──────────────────────────────────────────────────

describe('healthToPhase', () => {
  test('connected health maps to connected phase', () => {
    expect(healthToPhase('connected')).toBe('connected');
  });

  test('connecting health maps to connecting phase', () => {
    expect(healthToPhase('connecting')).toBe('connecting');
  });

  test('reconnecting health maps to reconnecting phase', () => {
    expect(healthToPhase('reconnecting')).toBe('reconnecting');
  });

  test('paused health maps to paused phase', () => {
    expect(healthToPhase('paused')).toBe('paused');
  });

  test('auth_required health maps to disconnected phase', () => {
    expect(healthToPhase('auth_required')).toBe('disconnected');
  });

  test('error health maps to disconnected phase', () => {
    expect(healthToPhase('error')).toBe('disconnected');
  });

  test('all health states map to valid phases', () => {
    const healthStates: ConnectionHealthState[] = [
      'paused', 'connecting', 'connected', 'reconnecting', 'auth_required', 'error',
    ];
    const validPhases = new Set<ConnectionPhase>(['disconnected', 'connecting', 'reconnecting', 'connected', 'paused']);

    for (const health of healthStates) {
      const phase = healthToPhase(health);
      expect(validPhases.has(phase)).toBe(true);
    }
  });

  test('CTA enablement via healthToPhase: auth_required allows Connect', () => {
    const phase = healthToPhase('auth_required');
    const cta = deriveCtaState(phase);
    expect(cta.connectEnabled).toBe(true);
    expect(cta.pauseEnabled).toBe(false);
  });

  test('CTA enablement via healthToPhase: reconnecting disables both buttons', () => {
    const phase = healthToPhase('reconnecting');
    expect(phase).toBe('reconnecting');
    const cta = deriveCtaState(phase);
    expect(cta.connectLabel).toBe('Reconnecting\u2026');
    expect(cta.connectEnabled).toBe(false);
    expect(cta.pauseEnabled).toBe(false);
  });

  test('CTA enablement via healthToPhase: error allows Connect', () => {
    const phase = healthToPhase('error');
    const cta = deriveCtaState(phase);
    expect(cta.connectEnabled).toBe(true);
    expect(cta.pauseEnabled).toBe(false);
  });
});

// ── deriveHealthStatusDisplay ──────────────────────────────────────

describe('deriveHealthStatusDisplay', () => {
  test('connected: green dot, Connected', () => {
    const status = deriveHealthStatusDisplay('connected');
    expect(status.dotClass).toBe('connected');
    expect(status.text).toBe('Connected');
  });

  test('connecting: red dot, Connecting\u2026', () => {
    const status = deriveHealthStatusDisplay('connecting');
    expect(status.dotClass).toBe('disconnected');
    expect(status.text).toBe('Connecting\u2026');
  });

  test('reconnecting: amber dot, Reconnecting automatically\u2026', () => {
    const status = deriveHealthStatusDisplay('reconnecting');
    expect(status.dotClass).toBe('paused');
    expect(status.text).toBe('Reconnecting automatically\u2026');
  });

  test('paused: amber dot, Paused', () => {
    const status = deriveHealthStatusDisplay('paused');
    expect(status.dotClass).toBe('paused');
    expect(status.text).toBe('Paused');
  });

  test('auth_required without detail: generic action required text', () => {
    const status = deriveHealthStatusDisplay('auth_required');
    expect(status.dotClass).toBe('disconnected');
    expect(status.text).toContain('Action required');
  });

  test('auth_required with error message: includes message in text', () => {
    const detail = makeDetail({ lastErrorMessage: 'Cloud token expired' });
    const status = deriveHealthStatusDisplay('auth_required', detail);
    expect(status.dotClass).toBe('disconnected');
    expect(status.text).toContain('Action required');
    expect(status.text).toContain('Cloud token expired');
  });

  test('error without detail: generic error text', () => {
    const status = deriveHealthStatusDisplay('error');
    expect(status.dotClass).toBe('disconnected');
    expect(status.text).toBe('Connection error');
  });

  test('error with error message: includes message in text', () => {
    const detail = makeDetail({ lastErrorMessage: 'Native host not installed' });
    const status = deriveHealthStatusDisplay('error', detail);
    expect(status.dotClass).toBe('disconnected');
    expect(status.text).toContain('Error');
    expect(status.text).toContain('Native host not installed');
  });

  test('reconnecting with disconnect code: still shows friendly message', () => {
    const detail = makeDetail({ lastDisconnectCode: 1006 });
    const status = deriveHealthStatusDisplay('reconnecting', detail);
    expect(status.dotClass).toBe('paused');
    expect(status.text).toBe('Reconnecting automatically\u2026');
  });

  test('all health states produce valid dot classes', () => {
    const healthStates: ConnectionHealthState[] = [
      'paused', 'connecting', 'connected', 'reconnecting', 'auth_required', 'error',
    ];
    const validDots = new Set(['connected', 'paused', 'disconnected']);

    for (const health of healthStates) {
      const status = deriveHealthStatusDisplay(health);
      expect(validDots.has(status.dotClass)).toBe(true);
    }
  });

  test('all health states produce non-empty status text', () => {
    const healthStates: ConnectionHealthState[] = [
      'paused', 'connecting', 'connected', 'reconnecting', 'auth_required', 'error',
    ];

    for (const health of healthStates) {
      const status = deriveHealthStatusDisplay(health);
      expect(status.text.length).toBeGreaterThan(0);
    }
  });
});

// ── shouldExpandTroubleshooting ────────────────────────────────────

describe('shouldExpandTroubleshooting', () => {
  test('expands for auth_required', () => {
    expect(shouldExpandTroubleshooting('auth_required')).toBe(true);
  });

  test('expands for error', () => {
    expect(shouldExpandTroubleshooting('error')).toBe(true);
  });

  test('collapses for connected', () => {
    expect(shouldExpandTroubleshooting('connected')).toBe(false);
  });

  test('collapses for connecting', () => {
    expect(shouldExpandTroubleshooting('connecting')).toBe(false);
  });

  test('collapses for reconnecting', () => {
    expect(shouldExpandTroubleshooting('reconnecting')).toBe(false);
  });

  test('collapses for paused', () => {
    expect(shouldExpandTroubleshooting('paused')).toBe(false);
  });

  test('happy path states never expand troubleshooting', () => {
    const happyStates: ConnectionHealthState[] = ['connected', 'connecting', 'reconnecting', 'paused'];
    for (const state of happyStates) {
      expect(shouldExpandTroubleshooting(state)).toBe(false);
    }
  });

  test('action-required states always expand troubleshooting', () => {
    const actionStates: ConnectionHealthState[] = ['auth_required', 'error'];
    for (const state of actionStates) {
      expect(shouldExpandTroubleshooting(state)).toBe(true);
    }
  });
});

// ── hasTroubleshootingControls ─────────────────────────────────────

describe('hasTroubleshootingControls', () => {
  test('returns true for local-pair', () => {
    expect(hasTroubleshootingControls('local-pair')).toBe(true);
  });

  test('returns true for cloud-oauth', () => {
    expect(hasTroubleshootingControls('cloud-oauth')).toBe(true);
  });

  test('returns false for unsupported', () => {
    expect(hasTroubleshootingControls('unsupported')).toBe(false);
  });

  test('returns false for null', () => {
    expect(hasTroubleshootingControls(null)).toBe(false);
  });
});

// ── Integrated state derivation scenarios ──────────────────────────

describe('integrated health-to-display scenarios', () => {
  test('typical user happy path: paused -> connecting -> connected', () => {
    // User opens popup when paused.
    let status = deriveHealthStatusDisplay('paused');
    expect(status.text).toBe('Paused');
    expect(shouldExpandTroubleshooting('paused')).toBe(false);

    // User clicks Connect.
    status = deriveHealthStatusDisplay('connecting');
    expect(status.text).toBe('Connecting\u2026');
    expect(shouldExpandTroubleshooting('connecting')).toBe(false);

    // Connection established.
    status = deriveHealthStatusDisplay('connected');
    expect(status.text).toBe('Connected');
    expect(shouldExpandTroubleshooting('connected')).toBe(false);
  });

  test('transient disconnect and auto-recovery', () => {
    // Connected, then disconnects.
    let status = deriveHealthStatusDisplay('connected');
    expect(status.text).toBe('Connected');

    // Auto-reconnecting.
    status = deriveHealthStatusDisplay('reconnecting');
    expect(status.text).toBe('Reconnecting automatically\u2026');
    expect(status.dotClass).toBe('paused');
    expect(shouldExpandTroubleshooting('reconnecting')).toBe(false);

    // Reconnect succeeds.
    status = deriveHealthStatusDisplay('connected');
    expect(status.text).toBe('Connected');
  });

  test('auth failure surfaces action required with expanded troubleshoot', () => {
    const detail = makeDetail({
      lastErrorMessage: "Automatic cloud sign-in failed",
    });

    const status = deriveHealthStatusDisplay('auth_required', detail);
    expect(status.dotClass).toBe('disconnected');
    expect(status.text).toContain('Action required');
    expect(status.text).toContain('Automatic cloud sign-in failed');

    // Troubleshoot should auto-expand.
    expect(shouldExpandTroubleshooting('auth_required')).toBe(true);

    // Connect button should be enabled for retry.
    const phase = healthToPhase('auth_required');
    const cta = deriveCtaState(phase);
    expect(cta.connectEnabled).toBe(true);
  });

  test('native host error surfaces error with expanded troubleshoot', () => {
    const detail = makeDetail({
      lastErrorMessage: 'Native host not installed',
    });

    const status = deriveHealthStatusDisplay('error', detail);
    expect(status.dotClass).toBe('disconnected');
    expect(status.text).toContain('Error');
    expect(status.text).toContain('Native host not installed');

    expect(shouldExpandTroubleshooting('error')).toBe(true);
  });

  test('single-assistant install: no selector, controls hidden when not needed', () => {
    // Single assistant: selector hidden.
    const selectorDisplay = deriveSelectorDisplay([localAssistant], localAssistant);
    expect(selectorDisplay.kind).toBe('hidden');

    // Connected state: troubleshoot collapsed.
    expect(shouldExpandTroubleshooting('connected')).toBe(false);
  });

  test('multi-assistant install: selector visible, controls preserved', () => {
    const selectorDisplay = deriveSelectorDisplay(
      [localAssistant, cloudAssistant],
      localAssistant,
    );
    expect(selectorDisplay.kind).toBe('visible');
    if (selectorDisplay.kind !== 'visible') throw new Error('unreachable');
    expect(selectorDisplay.options.length).toBe(2);
  });
});
