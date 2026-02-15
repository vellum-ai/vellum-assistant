import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

// ---------------------------------------------------------------------------
// Mock logger
// ---------------------------------------------------------------------------

mock.module('../util/logger.js', () => ({
  getLogger: () => new Proxy({} as Record<string, unknown>, {
    get: () => () => {},
  }),
}));

// ---------------------------------------------------------------------------
// Use encrypted backend (no keychain) with a temp store path
// ---------------------------------------------------------------------------

import { _overrideDeps, _resetDeps } from '../security/keychain.js';

_overrideDeps({
  isMacOS: () => false,
  isLinux: () => false,
  execFileSync: (() => '') as unknown as typeof import('node:child_process').execFileSync,
});

import { _resetBackend } from '../security/secure-keys.js';
import { _setStorePath } from '../security/encrypted-store.js';

const TEST_DIR = join(tmpdir(), `vellum-broker-fill-test-${randomBytes(4).toString('hex')}`);
const STORE_PATH = join(TEST_DIR, 'keys.enc');

// ---------------------------------------------------------------------------
// Mock registry to avoid double-registration
// ---------------------------------------------------------------------------

mock.module('../tools/registry.js', () => ({
  registerTool: () => {},
}));

// ---------------------------------------------------------------------------
// Imports under test
// ---------------------------------------------------------------------------

import { CredentialBroker } from '../tools/credentials/broker.js';
import { upsertCredentialMetadata, _setMetadataPath } from '../tools/credentials/metadata-store.js';
import { setSecureKey } from '../security/secure-keys.js';

describe('CredentialBroker.browserFill', () => {
  let broker: CredentialBroker;

  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    _setStorePath(STORE_PATH);
    _resetBackend();
    _setMetadataPath(join(TEST_DIR, 'metadata.json'));
    broker = new CredentialBroker();
  });

  afterEach(() => {
    _setMetadataPath(null);
    _setStorePath(null);
    _resetBackend();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  test('fills successfully when credential exists', async () => {
    upsertCredentialMetadata('github', 'token', { allowedTools: ['browser_fill_credential'] });
    setSecureKey('credential:github:token', 'ghp_secret123');

    let filledValue: string | undefined;
    const result = await broker.browserFill({
      service: 'github',
      field: 'token',
      toolName: 'browser_fill_credential',
      fill: async (value) => { filledValue = value; },
    });

    expect(result.success).toBe(true);
    expect(result.reason).toBeUndefined();
    // The fill callback received the plaintext
    expect(filledValue).toBe('ghp_secret123');
  });

  test('returns metadata-only result (no plaintext in return value)', async () => {
    upsertCredentialMetadata('github', 'token', { allowedTools: ['browser_fill_credential'] });
    setSecureKey('credential:github:token', 'ghp_secret123');

    const result = await broker.browserFill({
      service: 'github',
      field: 'token',
      toolName: 'browser_fill_credential',
      fill: async () => {},
    });

    // Result has no plaintext value — only success/failure metadata
    expect(result).toEqual({ success: true });
    expect('value' in result).toBe(false);
    expect('storageKey' in result).toBe(false);
  });

  test('fails when no credential metadata exists', async () => {
    const result = await broker.browserFill({
      service: 'nonexistent',
      field: 'token',
      toolName: 'browser_fill_credential',
      fill: async () => { throw new Error('should not be called'); },
    });

    expect(result.success).toBe(false);
    expect(result.reason).toContain('No credential found');
    expect(result.reason).toContain('nonexistent/token');
  });

  test('fails when metadata exists but no stored secret value', async () => {
    upsertCredentialMetadata('github', 'token', { allowedTools: ['browser_fill_credential'] });
    // No setSecureKey call — metadata exists but value doesn't

    const result = await broker.browserFill({
      service: 'github',
      field: 'token',
      toolName: 'browser_fill_credential',
      fill: async () => { throw new Error('should not be called'); },
    });

    expect(result.success).toBe(false);
    expect(result.reason).toContain('no stored value');
  });

  test('returns failure when fill callback throws', async () => {
    upsertCredentialMetadata('github', 'token', { allowedTools: ['browser_fill_credential'] });
    setSecureKey('credential:github:token', 'ghp_secret123');

    const result = await broker.browserFill({
      service: 'github',
      field: 'token',
      toolName: 'browser_fill_credential',
      fill: async () => { throw new Error('Element not found'); },
    });

    expect(result.success).toBe(false);
    expect(result.reason).toContain('Fill operation failed');
    expect(result.reason).toContain('Element not found');
  });

  test('handles multiple fills with different credentials', async () => {
    upsertCredentialMetadata('github', 'username', { allowedTools: ['browser_fill_credential'] });
    upsertCredentialMetadata('github', 'password', { allowedTools: ['browser_fill_credential'] });
    setSecureKey('credential:github:username', 'octocat');
    setSecureKey('credential:github:password', 'hunter2');

    const filled: Record<string, string> = {};

    const r1 = await broker.browserFill({
      service: 'github',
      field: 'username',
      toolName: 'browser_fill_credential',
      fill: async (v) => { filled.username = v; },
    });

    const r2 = await broker.browserFill({
      service: 'github',
      field: 'password',
      toolName: 'browser_fill_credential',
      fill: async (v) => { filled.password = v; },
    });

    expect(r1.success).toBe(true);
    expect(r2.success).toBe(true);
    expect(filled.username).toBe('octocat');
    expect(filled.password).toBe('hunter2');
  });

  test('accepts optional domain parameter', async () => {
    upsertCredentialMetadata('github', 'token', { allowedTools: ['browser_fill_credential'] });
    setSecureKey('credential:github:token', 'ghp_secret123');

    const result = await broker.browserFill({
      service: 'github',
      field: 'token',
      toolName: 'browser_fill_credential',
      domain: 'github.com',
      fill: async () => {},
    });

    // Domain policy enforcement is a stub — should still succeed
    expect(result.success).toBe(true);
  });

  test('denies fill when tool is not in allowedTools', async () => {
    upsertCredentialMetadata('github', 'token', { allowedTools: ['other_tool'] });
    setSecureKey('credential:github:token', 'ghp_secret123');

    let fillCalled = false;
    const result = await broker.browserFill({
      service: 'github',
      field: 'token',
      toolName: 'browser_fill_credential',
      fill: async () => { fillCalled = true; },
    });

    expect(result.success).toBe(false);
    expect(result.reason).toContain('not allowed');
    expect(result.reason).toContain('browser_fill_credential');
    // Fill callback must not be invoked when policy denies
    expect(fillCalled).toBe(false);
  });

  test('denies fill when allowedTools is empty (fail-closed)', async () => {
    upsertCredentialMetadata('github', 'token', { allowedTools: [] });
    setSecureKey('credential:github:token', 'ghp_secret123');

    const result = await broker.browserFill({
      service: 'github',
      field: 'token',
      toolName: 'browser_fill_credential',
      fill: async () => { throw new Error('should not be called'); },
    });

    expect(result.success).toBe(false);
    expect(result.reason).toContain('No tools are currently allowed');
  });

  test('fill callback error does not leak plaintext in result', async () => {
    upsertCredentialMetadata('github', 'token', { allowedTools: ['browser_fill_credential'] });
    setSecureKey('credential:github:token', 'ghp_supersecret');

    const result = await broker.browserFill({
      service: 'github',
      field: 'token',
      toolName: 'browser_fill_credential',
      fill: async () => { throw new Error('timeout'); },
    });

    expect(result.success).toBe(false);
    // Ensure the secret value doesn't appear in the error result
    expect(JSON.stringify(result)).not.toContain('ghp_supersecret');
  });
});
