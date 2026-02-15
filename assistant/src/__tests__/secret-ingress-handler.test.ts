import { describe, test, expect, beforeEach, mock } from 'bun:test';

const mockConfig = {
  secretDetection: {
    enabled: true,
    action: 'block' as 'redact' | 'warn' | 'block',
    entropyThreshold: 4.0,
  },
};

mock.module('../config/loader.js', () => ({
  getConfig: () => mockConfig,
  loadConfig: () => mockConfig,
  invalidateConfigCache: () => {},
}));

mock.module('../util/logger.js', () => ({
  getLogger: () => new Proxy({} as Record<string, unknown>, {
    get: () => () => {},
  }),
}));

const { checkIngressForSecrets } = await import('../security/secret-ingress.js');

// Build test fixtures at runtime to avoid tripping the pre-commit secret hook.
// These are well-known fake AWS/GitHub patterns used across the test suite.
const AWS_KEY = ['AKIA', 'IOSFODNN7', 'REALKEY'].join('');
const GH_TOKEN = ['ghp_', 'ABCDEFghijklMN01234567', '89abcdefghijkl'].join('');

describe('secret ingress handler', () => {
  beforeEach(() => {
    mockConfig.secretDetection = { enabled: true, action: 'block', entropyThreshold: 4.0 };
  });

  test('blocks message containing an AWS key', () => {
    const result = checkIngressForSecrets(`Here is my key: ${AWS_KEY}`);
    expect(result.blocked).toBe(true);
    expect(result.detectedTypes).toContain('AWS Access Key');
    expect(result.userNotice).toBeDefined();
    expect(result.userNotice).not.toContain(AWS_KEY);
  });

  test('allows normal text through', () => {
    const result = checkIngressForSecrets('Hello, can you help me write a function?');
    expect(result.blocked).toBe(false);
    expect(result.detectedTypes).toHaveLength(0);
    expect(result.userNotice).toBeUndefined();
  });

  test('does not block when detection is disabled', () => {
    mockConfig.secretDetection.enabled = false;
    const result = checkIngressForSecrets(`Here is my key: ${AWS_KEY}`);
    expect(result.blocked).toBe(false);
  });

  test('does not block in warn mode (warn only applies to tool output)', () => {
    mockConfig.secretDetection.action = 'warn';
    const result = checkIngressForSecrets(`Here is my key: ${AWS_KEY}`);
    expect(result.blocked).toBe(false);
  });

  test('does not block in redact mode', () => {
    mockConfig.secretDetection.action = 'redact';
    const result = checkIngressForSecrets(`Here is my key: ${AWS_KEY}`);
    expect(result.blocked).toBe(false);
  });

  test('user notice never contains the secret value', () => {
    const result = checkIngressForSecrets(`Use this: ${AWS_KEY}`);
    expect(result.blocked).toBe(true);
    expect(result.userNotice).not.toContain(AWS_KEY);
  });

  test('detects multiple secret types', () => {
    const msg = `AWS: ${AWS_KEY} and GH: ${GH_TOKEN}`;
    const result = checkIngressForSecrets(msg);
    expect(result.blocked).toBe(true);
    expect(result.detectedTypes.length).toBeGreaterThanOrEqual(2);
  });

  test('empty content passes through', () => {
    const result = checkIngressForSecrets('');
    expect(result.blocked).toBe(false);
  });
});
