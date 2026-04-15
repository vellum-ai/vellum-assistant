/**
 * Tests for the auth-profile derivation helper.
 *
 * Verifies that each known lockfile `cloud` value maps to the correct
 * auth profile, and that unknown values yield `unsupported`.
 */

import { describe, test, expect } from 'bun:test';

import {
  resolveAuthProfile,
  type AssistantAuthProfile,
  type LockfileTopology,
} from '../assistant-auth-profile.js';

describe('resolveAuthProfile', () => {
  test('maps "local" to local-pair', () => {
    const result = resolveAuthProfile({ cloud: 'local' });
    expect(result).toBe('local-pair' satisfies AssistantAuthProfile);
  });

  test('maps "apple-container" to local-pair', () => {
    const result = resolveAuthProfile({ cloud: 'apple-container' });
    expect(result).toBe('local-pair' satisfies AssistantAuthProfile);
  });

  test('maps "vellum" to cloud-oauth', () => {
    const result = resolveAuthProfile({ cloud: 'vellum' });
    expect(result).toBe('cloud-oauth' satisfies AssistantAuthProfile);
  });

  test('maps legacy "platform" to cloud-oauth', () => {
    const result = resolveAuthProfile({ cloud: 'platform' });
    expect(result).toBe('cloud-oauth' satisfies AssistantAuthProfile);
  });

  test('unknown cloud value yields unsupported', () => {
    const result = resolveAuthProfile({ cloud: 'some-future-topology' });
    expect(result).toBe('unsupported' satisfies AssistantAuthProfile);
  });

  test('empty string yields unsupported', () => {
    const result = resolveAuthProfile({ cloud: '' });
    expect(result).toBe('unsupported' satisfies AssistantAuthProfile);
  });

  test('runtimeUrl presence does not affect the mapping', () => {
    // The auth profile is derived from the `cloud` value alone. The
    // runtimeUrl field is part of the topology shape for downstream
    // consumers but does not change the auth decision.
    const withUrl: LockfileTopology = { cloud: 'local', runtimeUrl: 'http://127.0.0.1:7831' };
    const withoutUrl: LockfileTopology = { cloud: 'local' };
    expect(resolveAuthProfile(withUrl)).toBe('local-pair');
    expect(resolveAuthProfile(withoutUrl)).toBe('local-pair');

    const cloudWithUrl: LockfileTopology = {
      cloud: 'vellum',
      runtimeUrl: 'https://rt.vellum.cloud',
    };
    const cloudWithoutUrl: LockfileTopology = { cloud: 'vellum' };
    expect(resolveAuthProfile(cloudWithUrl)).toBe('cloud-oauth');
    expect(resolveAuthProfile(cloudWithoutUrl)).toBe('cloud-oauth');
  });

  test('is stable across all known cloud values', () => {
    // Pin the full mapping so a future refactor that accidentally
    // changes a mapping is caught by this test.
    const expected: Array<[string, AssistantAuthProfile]> = [
      ['local', 'local-pair'],
      ['apple-container', 'local-pair'],
      ['vellum', 'cloud-oauth'],
      ['platform', 'cloud-oauth'],
    ];
    for (const [cloud, profile] of expected) {
      expect(resolveAuthProfile({ cloud })).toBe(profile);
    }
  });
});
