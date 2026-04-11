/**
 * Unit tests for popup-state.ts view-state helpers.
 *
 * Exercises the pure display-logic functions without a Chrome runtime:
 *   - deriveSelectorDisplay: hidden for 0/1 assistants, visible for 2+
 *   - assistantLabel: readable label derivation
 *   - shouldShowLocalSection / shouldShowCloudSection: auth-profile gating
 *   - deriveCtaState: CTA label/enablement for each connection phase
 *   - deriveStatusDisplay: status dot class and text for each phase
 */

import { describe, test, expect } from 'bun:test';

import {
  deriveSelectorDisplay,
  assistantLabel,
  shouldShowLocalSection,
  shouldShowCloudSection,
  deriveCtaState,
  deriveStatusDisplay,
  type ConnectionPhase,
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

  test('all phases produce consistent label/enablement pairs', () => {
    const phases: ConnectionPhase[] = ['disconnected', 'connecting', 'connected', 'paused'];
    for (const phase of phases) {
      const state = deriveCtaState(phase);
      // Pause should only be enabled when connected
      expect(state.pauseEnabled).toBe(phase === 'connected');
      // Connect should be disabled only when connecting or connected
      expect(state.connectEnabled).toBe(phase !== 'connecting' && phase !== 'connected');
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

  test('display transitions: disconnected -> connecting -> connected -> paused -> disconnected', () => {
    const transitions: ConnectionPhase[] = [
      'disconnected',
      'connecting',
      'connected',
      'paused',
      'disconnected',
    ];
    const expectedDots = ['disconnected', 'disconnected', 'connected', 'paused', 'disconnected'];
    const expectedTexts = [
      'Not connected',
      'Connecting\u2026',
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
