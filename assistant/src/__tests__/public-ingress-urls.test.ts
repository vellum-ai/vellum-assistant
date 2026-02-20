import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';

// ---------------------------------------------------------------------------
// Mocks — silence logger output during tests
// ---------------------------------------------------------------------------

function makeLoggerStub(): Record<string, unknown> {
  const stub: Record<string, unknown> = {};
  for (const m of ['info', 'warn', 'error', 'debug', 'trace', 'fatal', 'silent', 'child']) {
    stub[m] = m === 'child' ? () => makeLoggerStub() : () => {};
  }
  return stub;
}

mock.module('../util/logger.js', () => ({
  getLogger: () => makeLoggerStub(),
}));

import {
  getPublicBaseUrl,
  getTwilioVoiceWebhookUrl,
  getTwilioStatusCallbackUrl,
  getTwilioConnectActionUrl,
  getTwilioRelayUrl,
  getOAuthCallbackUrl,
  getTelegramWebhookUrl,
} from '../inbound/public-ingress-urls.js';

// ---------------------------------------------------------------------------
// getPublicBaseUrl — fallback chain
// ---------------------------------------------------------------------------

describe('getPublicBaseUrl', () => {
  let savedIngressEnv: string | undefined;

  beforeEach(() => {
    savedIngressEnv = process.env.INGRESS_PUBLIC_BASE_URL;
    delete process.env.INGRESS_PUBLIC_BASE_URL;
  });

  afterEach(() => {
    if (savedIngressEnv !== undefined) {
      process.env.INGRESS_PUBLIC_BASE_URL = savedIngressEnv;
    } else {
      delete process.env.INGRESS_PUBLIC_BASE_URL;
    }
  });

  test('returns ingress.publicBaseUrl when set', () => {
    const result = getPublicBaseUrl({
      ingress: { publicBaseUrl: 'https://ingress.example.com/' },
    });
    expect(result).toBe('https://ingress.example.com');
  });

  test('falls back to INGRESS_PUBLIC_BASE_URL env var when ingress.publicBaseUrl is empty', () => {
    process.env.INGRESS_PUBLIC_BASE_URL = 'https://ingress-env.example.com/';
    const result = getPublicBaseUrl({
      ingress: { publicBaseUrl: '' },
    });
    expect(result).toBe('https://ingress-env.example.com');
  });

  test('falls back to INGRESS_PUBLIC_BASE_URL env var when config is empty', () => {
    process.env.INGRESS_PUBLIC_BASE_URL = 'https://ingress-env.example.com';
    const result = getPublicBaseUrl({});
    expect(result).toBe('https://ingress-env.example.com');
  });

  test('throws when no source provides a value', () => {
    expect(() => getPublicBaseUrl({
      ingress: { publicBaseUrl: '' },
    })).toThrow(/No public base URL configured/);
  });

  test('throws when all sources are undefined', () => {
    expect(() => getPublicBaseUrl({})).toThrow(/No public base URL configured/);
  });

  test('normalizes trailing slashes from ingress.publicBaseUrl', () => {
    const result = getPublicBaseUrl({
      ingress: { publicBaseUrl: 'https://example.com///' },
    });
    expect(result).toBe('https://example.com');
  });

  test('trims whitespace from ingress.publicBaseUrl', () => {
    const result = getPublicBaseUrl({
      ingress: { publicBaseUrl: '  https://example.com  ' },
    });
    expect(result).toBe('https://example.com');
  });

  test('skips whitespace-only ingress.publicBaseUrl and falls through to env', () => {
    process.env.INGRESS_PUBLIC_BASE_URL = 'https://ingress-env.example.com';
    const result = getPublicBaseUrl({
      ingress: { publicBaseUrl: '   ' },
    });
    expect(result).toBe('https://ingress-env.example.com');
  });

  test('normalizes trailing slashes from INGRESS_PUBLIC_BASE_URL', () => {
    process.env.INGRESS_PUBLIC_BASE_URL = 'https://ingress-env.example.com///';
    const result = getPublicBaseUrl({});
    expect(result).toBe('https://ingress-env.example.com');
  });

  test('trims whitespace from INGRESS_PUBLIC_BASE_URL', () => {
    process.env.INGRESS_PUBLIC_BASE_URL = '  https://ingress-env.example.com  ';
    const result = getPublicBaseUrl({});
    expect(result).toBe('https://ingress-env.example.com');
  });
});

// ---------------------------------------------------------------------------
// getTwilioVoiceWebhookUrl
// ---------------------------------------------------------------------------

describe('getTwilioVoiceWebhookUrl', () => {
  test('builds correct URL with callSessionId', () => {
    const url = getTwilioVoiceWebhookUrl(
      { ingress: { publicBaseUrl: 'https://example.com' } },
      'session-123',
    );
    expect(url).toBe('https://example.com/webhooks/twilio/voice?callSessionId=session-123');
  });

  test('normalizes base URL before composing', () => {
    const url = getTwilioVoiceWebhookUrl(
      { ingress: { publicBaseUrl: 'https://example.com/' } },
      'abc',
    );
    expect(url).toBe('https://example.com/webhooks/twilio/voice?callSessionId=abc');
  });
});

// ---------------------------------------------------------------------------
// getTwilioStatusCallbackUrl
// ---------------------------------------------------------------------------

describe('getTwilioStatusCallbackUrl', () => {
  test('builds correct URL', () => {
    const url = getTwilioStatusCallbackUrl({
      ingress: { publicBaseUrl: 'https://example.com' },
    });
    expect(url).toBe('https://example.com/webhooks/twilio/status');
  });
});

// ---------------------------------------------------------------------------
// getTwilioConnectActionUrl
// ---------------------------------------------------------------------------

describe('getTwilioConnectActionUrl', () => {
  test('builds correct URL', () => {
    const url = getTwilioConnectActionUrl({
      ingress: { publicBaseUrl: 'https://example.com' },
    });
    expect(url).toBe('https://example.com/webhooks/twilio/connect-action');
  });
});

// ---------------------------------------------------------------------------
// getTwilioRelayUrl — scheme conversion
// ---------------------------------------------------------------------------

describe('getTwilioRelayUrl', () => {
  test('converts https to wss', () => {
    const url = getTwilioRelayUrl({
      ingress: { publicBaseUrl: 'https://example.com' },
    });
    expect(url).toBe('wss://example.com/webhooks/twilio/relay');
  });

  test('converts http to ws', () => {
    const url = getTwilioRelayUrl({
      ingress: { publicBaseUrl: 'http://localhost:7821' },
    });
    expect(url).toBe('ws://localhost:7821/webhooks/twilio/relay');
  });

  test('normalizes trailing slash before conversion', () => {
    const url = getTwilioRelayUrl({
      ingress: { publicBaseUrl: 'https://example.com/' },
    });
    expect(url).toBe('wss://example.com/webhooks/twilio/relay');
  });
});

// ---------------------------------------------------------------------------
// getOAuthCallbackUrl
// ---------------------------------------------------------------------------

describe('getOAuthCallbackUrl', () => {
  test('builds correct URL', () => {
    const url = getOAuthCallbackUrl({
      ingress: { publicBaseUrl: 'https://example.com' },
    });
    expect(url).toBe('https://example.com/webhooks/oauth/callback');
  });
});


// ---------------------------------------------------------------------------
// getTelegramWebhookUrl
// ---------------------------------------------------------------------------

describe('getTelegramWebhookUrl', () => {
  test('builds correct URL', () => {
    const url = getTelegramWebhookUrl({
      ingress: { publicBaseUrl: 'https://example.com' },
    });
    expect(url).toBe('https://example.com/webhooks/telegram');
  });

  test('normalizes trailing slash before composing', () => {
    const url = getTelegramWebhookUrl({
      ingress: { publicBaseUrl: 'https://example.com/' },
    });
    expect(url).toBe('https://example.com/webhooks/telegram');
  });
});
