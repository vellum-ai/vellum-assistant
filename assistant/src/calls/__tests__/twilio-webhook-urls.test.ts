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

mock.module('../../util/logger.js', () => ({
  getLogger: () => makeLoggerStub(),
}));

import {
  normalizeBaseUrl,
  buildTwilioVoiceWebhookUrl,
  buildTwilioStatusCallbackUrl,
  getWebhookBaseUrl,
} from '../twilio-webhook-urls.js';

// ---------------------------------------------------------------------------
// normalizeBaseUrl
// ---------------------------------------------------------------------------

describe('normalizeBaseUrl', () => {
  test('returns already-clean URL unchanged', () => {
    expect(normalizeBaseUrl('https://example.com')).toBe('https://example.com');
  });

  test('strips trailing slash', () => {
    expect(normalizeBaseUrl('https://example.com/')).toBe('https://example.com');
  });

  test('strips multiple trailing slashes', () => {
    expect(normalizeBaseUrl('https://example.com///')).toBe('https://example.com');
  });

  test('trims leading and trailing whitespace', () => {
    expect(normalizeBaseUrl('  https://example.com  ')).toBe('https://example.com');
  });

  test('trims whitespace and strips trailing slash together', () => {
    expect(normalizeBaseUrl('  https://example.com/  ')).toBe('https://example.com');
  });
});

// ---------------------------------------------------------------------------
// buildTwilioVoiceWebhookUrl
// ---------------------------------------------------------------------------

describe('buildTwilioVoiceWebhookUrl', () => {
  test('returns correct URL with callSessionId', () => {
    const url = buildTwilioVoiceWebhookUrl('https://example.com', 'session-123');
    expect(url).toBe('https://example.com/webhooks/twilio/voice?callSessionId=session-123');
  });

  test('normalizes base URL before composing', () => {
    const url = buildTwilioVoiceWebhookUrl('https://example.com/', 'abc');
    expect(url).toBe('https://example.com/webhooks/twilio/voice?callSessionId=abc');
  });
});

// ---------------------------------------------------------------------------
// buildTwilioStatusCallbackUrl
// ---------------------------------------------------------------------------

describe('buildTwilioStatusCallbackUrl', () => {
  test('returns correct URL', () => {
    const url = buildTwilioStatusCallbackUrl('https://example.com');
    expect(url).toBe('https://example.com/webhooks/twilio/status');
  });

  test('normalizes base URL before composing', () => {
    const url = buildTwilioStatusCallbackUrl('https://example.com/');
    expect(url).toBe('https://example.com/webhooks/twilio/status');
  });
});

// ---------------------------------------------------------------------------
// getWebhookBaseUrl
// ---------------------------------------------------------------------------

describe('getWebhookBaseUrl', () => {
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env.TWILIO_WEBHOOK_BASE_URL;
    delete process.env.TWILIO_WEBHOOK_BASE_URL;
  });

  afterEach(() => {
    if (savedEnv !== undefined) {
      process.env.TWILIO_WEBHOOK_BASE_URL = savedEnv;
    } else {
      delete process.env.TWILIO_WEBHOOK_BASE_URL;
    }
  });

  test('uses config value when set', () => {
    const result = getWebhookBaseUrl({ calls: { webhookBaseUrl: 'https://config.example.com/' } });
    expect(result).toBe('https://config.example.com');
  });

  test('falls back to env var when config value is empty', () => {
    process.env.TWILIO_WEBHOOK_BASE_URL = 'https://env.example.com/';
    const result = getWebhookBaseUrl({ calls: { webhookBaseUrl: '' } });
    expect(result).toBe('https://env.example.com');
  });

  test('falls back to env var when config value is undefined', () => {
    process.env.TWILIO_WEBHOOK_BASE_URL = 'https://env.example.com';
    const result = getWebhookBaseUrl({ calls: {} });
    expect(result).toBe('https://env.example.com');
  });

  test('throws when neither config nor env var is set', () => {
    expect(() => getWebhookBaseUrl({ calls: { webhookBaseUrl: '' } })).toThrow(
      /No webhook base URL configured/,
    );
  });

  test('throws when config is undefined and env var is unset', () => {
    expect(() => getWebhookBaseUrl({ calls: {} })).toThrow(
      /No webhook base URL configured/,
    );
  });

  test('normalizes the returned URL', () => {
    const result = getWebhookBaseUrl({ calls: { webhookBaseUrl: '  https://example.com/  ' } });
    expect(result).toBe('https://example.com');
  });

  test('falls through when config value is whitespace-only', () => {
    process.env.TWILIO_WEBHOOK_BASE_URL = 'https://env.example.com';
    const result = getWebhookBaseUrl({ calls: { webhookBaseUrl: '   ' } });
    expect(result).toBe('https://env.example.com');
  });

  test('falls through when config value is slash-only', () => {
    process.env.TWILIO_WEBHOOK_BASE_URL = 'https://env.example.com';
    const result = getWebhookBaseUrl({ calls: { webhookBaseUrl: '///' } });
    expect(result).toBe('https://env.example.com');
  });

  test('throws when config is whitespace-only and env var is unset', () => {
    expect(() => getWebhookBaseUrl({ calls: { webhookBaseUrl: '   ' } })).toThrow(
      /No webhook base URL configured/,
    );
  });

  test('throws when env var is whitespace-only and config is empty', () => {
    process.env.TWILIO_WEBHOOK_BASE_URL = '   ';
    expect(() => getWebhookBaseUrl({ calls: {} })).toThrow(
      /No webhook base URL configured/,
    );
  });
});
