/**
 * Unit tests for caller identity resolution in call-domain.ts.
 *
 * Validates the strict implicit-default policy:
 * - Implicit calls (no explicit mode) always use assistant_number.
 * - Explicit user_number calls succeed when eligible.
 * - Explicit user_number calls fail clearly when missing/ineligible.
 * - Explicit override rejected when allowPerCallOverride=false.
 */
import { describe, test, expect, mock } from 'bun:test';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const testDir = realpathSync(mkdtempSync(join(tmpdir(), 'call-domain-test-')));

mock.module('../util/platform.js', () => ({
  getRootDir: () => testDir,
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

mock.module('../calls/twilio-config.js', () => ({
  getTwilioConfig: (assistantId?: string) => ({
    accountSid: 'AC_test',
    authToken: 'test_token',
    phoneNumber: assistantId === 'ast-alpha' ? '+15550003333' : '+15550001111',
    webhookBaseUrl: 'https://test.example.com',
    wssBaseUrl: 'wss://test.example.com',
  }),
}));

mock.module('../calls/twilio-provider.js', () => ({
  TwilioConversationRelayProvider: class {
    async checkCallerIdEligibility(number: string) {
      // Simulate: +15550002222 is eligible, others are not
      if (number === '+15550002222') return { eligible: true };
      return { eligible: false, reason: `${number} is not eligible as a caller ID` };
    }
  },
}));

mock.module('../security/secure-keys.js', () => ({
  getSecureKey: () => null,
}));

import { resolveCallerIdentity } from '../calls/call-domain.js';
import type { AssistantConfig } from '../config/types.js';

function makeConfig(overrides: {
  allowPerCallOverride?: boolean;
  userNumber?: string;
} = {}): AssistantConfig {
  return {
    calls: {
      callerIdentity: {
        allowPerCallOverride: overrides.allowPerCallOverride ?? true,
        userNumber: overrides.userNumber,
      },
    },
  } as unknown as AssistantConfig;
}

describe('resolveCallerIdentity — strict implicit-default policy', () => {
  test('implicit call defaults to assistant_number', async () => {
    const result = await resolveCallerIdentity(makeConfig());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.mode).toBe('assistant_number');
      expect(result.fromNumber).toBe('+15550001111');
      expect(result.source).toBe('implicit_default');
    }
  });

  test('implicit call uses assistant_number even when userNumber is configured', async () => {
    const result = await resolveCallerIdentity(
      makeConfig({ userNumber: '+15550002222' }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.mode).toBe('assistant_number');
      expect(result.fromNumber).toBe('+15550001111');
      expect(result.source).toBe('implicit_default');
    }
  });

  test('assistant_number resolves from assistant-scoped Twilio number when assistantId is provided', async () => {
    const result = await resolveCallerIdentity(makeConfig(), undefined, 'ast-alpha');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.mode).toBe('assistant_number');
      expect(result.fromNumber).toBe('+15550003333');
      expect(result.source).toBe('implicit_default');
    }
  });

  test('explicit user_number succeeds when eligible', async () => {
    const result = await resolveCallerIdentity(
      makeConfig({ userNumber: '+15550002222' }),
      'user_number',
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.mode).toBe('user_number');
      expect(result.fromNumber).toBe('+15550002222');
      expect(result.source).toBe('user_config');
    }
  });

  test('explicit user_number fails when no user phone configured', async () => {
    const result = await resolveCallerIdentity(makeConfig(), 'user_number');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('user_number');
      expect(result.error).toContain('user phone number');
    }
  });

  test('explicit user_number fails when number is ineligible', async () => {
    const result = await resolveCallerIdentity(
      makeConfig({ userNumber: '+15559999999' }),
      'user_number',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('not eligible');
    }
  });

  test('explicit override rejected when allowPerCallOverride=false', async () => {
    const result = await resolveCallerIdentity(
      makeConfig({ allowPerCallOverride: false, userNumber: '+15550002222' }),
      'user_number',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('override is disabled');
    }
  });

  test('explicit assistant_number override succeeds when allowed', async () => {
    const result = await resolveCallerIdentity(makeConfig(), 'assistant_number');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.mode).toBe('assistant_number');
      expect(result.source).toBe('per_call_override');
    }
  });

  test('invalid mode returns error', async () => {
    const result = await resolveCallerIdentity(
      makeConfig(),
      'custom_number' as 'assistant_number',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('Invalid callerIdentityMode');
    }
  });
});
