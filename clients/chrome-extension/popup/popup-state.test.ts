/**
 * Unit tests for popup-state.ts view-state helpers.
 *
 * Exercises the pure display-logic functions without a Chrome runtime:
 *   - deriveSelectorDisplay: hidden for 0/1 assistants, visible for 2+
 *   - assistantLabel: readable label derivation
 *   - shouldShowLocalSection / shouldShowCloudSection: auth-profile gating
 */

import { describe, test, expect } from 'bun:test';

import {
  deriveSelectorDisplay,
  assistantLabel,
  shouldShowLocalSection,
  shouldShowCloudSection,
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
