import { describe, expect,test } from 'bun:test';

import {
  getFailoverProvider,
  initializeProviders,
  resolveProviderSelection,
} from '../providers/registry.js';

/**
 * Tests for fail-open provider selection: when the configured primary provider
 * is unavailable, the system should automatically fall back to the first
 * available provider in the provider order.
 */

/** Initialize registry with anthropic + openai for most tests. */
function setupTwoProviders() {
  initializeProviders({
    apiKeys: { anthropic: 'test-key', openai: 'test-key' },
    provider: 'anthropic',
    model: 'test-model',
  });
}

/** Initialize registry with no providers (empty keys, non-registerable primary). */
function setupNoProviders() {
  initializeProviders({
    apiKeys: {},
    provider: 'gemini',
    model: 'test-model',
  });
}

describe('resolveProviderSelection', () => {
  test('configured primary available → selected as primary', () => {
    setupTwoProviders();
    const result = resolveProviderSelection('anthropic', ['openai']);
    expect(result.selectedPrimary).toBe('anthropic');
    expect(result.usedFallbackPrimary).toBe(false);
    expect(result.availableProviders).toEqual(['anthropic', 'openai']);
  });

  test('configured primary unavailable + alternate available → alternate selected', () => {
    setupTwoProviders();
    const result = resolveProviderSelection('gemini', ['anthropic', 'openai']);
    expect(result.selectedPrimary).toBe('anthropic');
    expect(result.usedFallbackPrimary).toBe(true);
    expect(result.availableProviders).toEqual(['anthropic', 'openai']);
  });

  test('configured primary unavailable + first alternate also unavailable → second alternate selected', () => {
    setupTwoProviders();
    const result = resolveProviderSelection('gemini', ['fireworks', 'openai']);
    expect(result.selectedPrimary).toBe('openai');
    expect(result.usedFallbackPrimary).toBe(true);
    expect(result.availableProviders).toEqual(['openai']);
  });

  test('deduplicates entries in providerOrder', () => {
    setupTwoProviders();
    const result = resolveProviderSelection('anthropic', ['anthropic', 'openai', 'openai']);
    expect(result.availableProviders).toEqual(['anthropic', 'openai']);
  });

  test('unknown entries in providerOrder are filtered out', () => {
    setupTwoProviders();
    const result = resolveProviderSelection('anthropic', ['nonexistent', 'openai']);
    expect(result.availableProviders).toEqual(['anthropic', 'openai']);
  });

  test('no available providers → null selectedPrimary', () => {
    setupTwoProviders();
    const result = resolveProviderSelection('gemini', ['fireworks', 'ollama']);
    expect(result.selectedPrimary).toBeNull();
    expect(result.usedFallbackPrimary).toBe(false);
    expect(result.availableProviders).toEqual([]);
  });

  test('empty providerOrder with available primary → primary only', () => {
    setupTwoProviders();
    const result = resolveProviderSelection('anthropic', []);
    expect(result.selectedPrimary).toBe('anthropic');
    expect(result.usedFallbackPrimary).toBe(false);
    expect(result.availableProviders).toEqual(['anthropic']);
  });

  test('empty providerOrder with unavailable primary → null', () => {
    setupTwoProviders();
    const result = resolveProviderSelection('gemini', []);
    expect(result.selectedPrimary).toBeNull();
    expect(result.availableProviders).toEqual([]);
  });
});

describe('getFailoverProvider (fail-open)', () => {
  test('returns provider when primary is available', () => {
    setupTwoProviders();
    const provider = getFailoverProvider('anthropic', ['openai']);
    expect(provider).toBeDefined();
  });

  test('returns provider when primary is unavailable but alternate exists', () => {
    setupTwoProviders();
    const provider = getFailoverProvider('gemini', ['anthropic', 'openai']);
    expect(provider).toBeDefined();
  });

  test('throws ConfigError when no providers are available', () => {
    setupNoProviders();
    expect(() => getFailoverProvider('gemini', ['fireworks'])).toThrow(
      /No providers available/,
    );
  });

  test('single available provider returns it directly (no failover wrapper)', () => {
    setupTwoProviders();
    const provider = getFailoverProvider('gemini', ['anthropic']);
    // Should be a RetryProvider wrapping AnthropicProvider, not a FailoverProvider
    expect(provider.name).not.toBe('failover');
  });
});
