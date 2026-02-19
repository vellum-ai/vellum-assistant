/**
 * Tests for TwilioConversationRelayProvider — signature validation and
 * fail-closed auth token behavior.
 */
import { describe, test, expect, beforeEach, mock } from 'bun:test';
import { createHmac } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const testDir = mkdtempSync(join(tmpdir(), 'twilio-provider-test-'));

mock.module('../util/platform.js', () => ({
  getDataDir: () => testDir,
  isMacOS: () => process.platform === 'darwin',
  isLinux: () => process.platform === 'linux',
  isWindows: () => process.platform === 'win32',
  getSocketPath: () => join(testDir, 'test.sock'),
  getPidPath: () => join(testDir, 'test.pid'),
  getDbPath: () => join(testDir, 'test.db'),
  getLogPath: () => join(testDir, 'test.log'),
  ensureDataDir: () => {},
}));

mock.module('../util/logger.js', () => ({
  getLogger: () => new Proxy({} as Record<string, unknown>, {
    get: () => () => {},
  }),
}));

// Start with a configured auth token
let mockAuthToken: string | undefined = 'test-auth-token-secret';

mock.module('../security/secure-keys.js', () => ({
  getSecureKey: (account: string) => {
    if (account === 'twilio_auth_token') return mockAuthToken;
    return undefined;
  },
}));

import { TwilioConversationRelayProvider } from '../calls/twilio-provider.js';

// ── Helpers ────────────────────────────────────────────────────────────

function computeValidSignature(
  url: string,
  params: Record<string, string>,
  authToken: string,
): string {
  const sortedKeys = Object.keys(params).sort();
  let data = url;
  for (const key of sortedKeys) {
    data += key + params[key];
  }
  return createHmac('sha1', authToken).update(data).digest('base64');
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('TwilioConversationRelayProvider', () => {
  beforeEach(() => {
    mockAuthToken = 'test-auth-token-secret';
  });

  describe('verifyWebhookSignature', () => {
    const testUrl = 'https://example.com/v1/calls/twilio/status';
    const testParams = { CallSid: 'CA123', CallStatus: 'completed' };

    test('returns true for a valid signature', () => {
      const authToken = 'test-auth-token-secret';
      const sig = computeValidSignature(testUrl, testParams, authToken);
      const result = TwilioConversationRelayProvider.verifyWebhookSignature(
        testUrl,
        testParams,
        sig,
        authToken,
      );
      expect(result).toBe(true);
    });

    test('returns false for an invalid signature', () => {
      const authToken = 'test-auth-token-secret';
      const result = TwilioConversationRelayProvider.verifyWebhookSignature(
        testUrl,
        testParams,
        'invalid-signature-base64',
        authToken,
      );
      expect(result).toBe(false);
    });

    test('returns false when signature is computed with a different auth token', () => {
      const authToken = 'test-auth-token-secret';
      const wrongTokenSig = computeValidSignature(testUrl, testParams, 'wrong-token');
      const result = TwilioConversationRelayProvider.verifyWebhookSignature(
        testUrl,
        testParams,
        wrongTokenSig,
        authToken,
      );
      expect(result).toBe(false);
    });

    test('handles empty params', () => {
      const authToken = 'test-auth-token-secret';
      const sig = computeValidSignature(testUrl, {}, authToken);
      const result = TwilioConversationRelayProvider.verifyWebhookSignature(
        testUrl,
        {},
        sig,
        authToken,
      );
      expect(result).toBe(true);
    });

    test('sorts params alphabetically for signature computation', () => {
      const authToken = 'test-auth-token-secret';
      const params = { Zebra: '1', Alpha: '2', Middle: '3' };
      const sig = computeValidSignature(testUrl, params, authToken);
      const result = TwilioConversationRelayProvider.verifyWebhookSignature(
        testUrl,
        params,
        sig,
        authToken,
      );
      expect(result).toBe(true);
    });
  });

  describe('getAuthToken', () => {
    test('returns the auth token when configured', () => {
      mockAuthToken = 'my-secret-token';
      const token = TwilioConversationRelayProvider.getAuthToken();
      expect(token).toBe('my-secret-token');
    });

    test('returns null when auth token is not configured', () => {
      mockAuthToken = undefined;
      const token = TwilioConversationRelayProvider.getAuthToken();
      expect(token).toBeNull();
    });
  });
});
