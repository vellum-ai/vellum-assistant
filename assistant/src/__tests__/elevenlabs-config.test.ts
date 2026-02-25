import { describe, expect, mock,test } from 'bun:test';

// ── Mocks (must come before source imports) ──────────────────────────

let mockApiKey: string | null = null;

mock.module('../util/logger.js', () => ({
  getLogger: () => new Proxy({} as Record<string, unknown>, {
    get: () => () => {},
  }),
}));

mock.module('../security/secure-keys.js', () => ({
  getSecureKey: (key: string) => {
    if (key === 'credential:elevenlabs:api_key') return mockApiKey;
    return null;
  },
}));

let mockVoiceConfig = {
  elevenlabs: {
    agentId: 'agent-123',
    apiBaseUrl: 'https://api.elevenlabs.io',
    registerCallTimeoutMs: 5000,
  },
};

mock.module('../config/loader.js', () => ({
  getConfig: () => ({
    calls: { voice: mockVoiceConfig },
  }),
}));

import { getElevenLabsConfig } from '../calls/elevenlabs-config.js';

describe('elevenlabs-config', () => {
  test('returns config when API key and agent ID are set', () => {
    mockApiKey = 'sk-test-key-123';
    mockVoiceConfig = {
      elevenlabs: {
        agentId: 'agent-abc',
        apiBaseUrl: 'https://api.elevenlabs.io',
        registerCallTimeoutMs: 10000,
      },
    };

    const config = getElevenLabsConfig();
    expect(config.apiKey).toBe('sk-test-key-123');
    expect(config.agentId).toBe('agent-abc');
    expect(config.apiBaseUrl).toBe('https://api.elevenlabs.io');
    expect(config.registerCallTimeoutMs).toBe(10000);
  });

  test('throws ConfigError when API key is missing', () => {
    mockApiKey = null;
    mockVoiceConfig = {
      elevenlabs: {
        agentId: 'agent-abc',
        apiBaseUrl: 'https://api.elevenlabs.io',
        registerCallTimeoutMs: 5000,
      },
    };

    expect(() => getElevenLabsConfig()).toThrow(/API key is not configured/);
  });

  test('throws ConfigError when API key is empty string', () => {
    mockApiKey = '';
    mockVoiceConfig = {
      elevenlabs: {
        agentId: 'agent-abc',
        apiBaseUrl: 'https://api.elevenlabs.io',
        registerCallTimeoutMs: 5000,
      },
    };

    expect(() => getElevenLabsConfig()).toThrow(/API key is not configured/);
  });

  test('throws ConfigError when agent ID is missing', () => {
    mockApiKey = 'sk-valid';
    mockVoiceConfig = {
      elevenlabs: {
        agentId: '',
        apiBaseUrl: 'https://api.elevenlabs.io',
        registerCallTimeoutMs: 5000,
      },
    };

    expect(() => getElevenLabsConfig()).toThrow(/agent ID is not configured/);
  });
});
