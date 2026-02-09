import { describe, test, expect } from 'bun:test';
import { getProvider, initializeProviders, listProviders } from '../providers/registry.js';

describe('provider registry (ollama)', () => {
  test('registers ollama when selected provider has no API key', () => {
    initializeProviders({
      apiKeys: {},
      provider: 'ollama',
      model: 'claude-sonnet-4-5-20250929',
    });

    const provider = getProvider('ollama');
    expect(provider.name).toBe('ollama');
    expect(listProviders()).toEqual(['ollama']);
  });
});
