import { describe, test, expect, beforeEach, afterEach, afterAll, mock } from 'bun:test';
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

import { _overrideDeps } from '../security/keychain.js';

_overrideDeps({
  isMacOS: () => false,
  isLinux: () => false,
  execFileSync: (() => '') as unknown as typeof import('node:child_process').execFileSync,
});

import { _resetBackend } from '../security/secure-keys.js';
import { _setStorePath } from '../security/encrypted-store.js';

const TEST_DIR = join(tmpdir(), `vellum-broker-server-use-test-${randomBytes(4).toString('hex')}`);
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

// ---------------------------------------------------------------------------
// Tests — serverUse (publish_page / unpublish_page regression)
// ---------------------------------------------------------------------------

afterAll(() => { mock.restore(); });

describe('CredentialBroker.serverUse', () => {
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

  test('executes callback with credential value and returns result', async () => {
    upsertCredentialMetadata('vercel', 'api_token', {
      allowedTools: ['publish_page'],
    });
    setSecureKey('credential:vercel:api_token', 'test-vercel-token');

    const result = await broker.serverUse({
      service: 'vercel',
      field: 'api_token',
      toolName: 'publish_page',
      execute: async (token) => {
        // Verify the callback receives the actual secret
        expect(token).toBe('test-vercel-token');
        return { deploymentId: 'dpl_123', url: 'https://example.vercel.app' };
      },
    });

    expect(result.success).toBe(true);
    expect(result.result).toEqual({ deploymentId: 'dpl_123', url: 'https://example.vercel.app' });
  });

  test('denies when tool is not in allowedTools', async () => {
    upsertCredentialMetadata('vercel', 'api_token', {
      allowedTools: ['publish_page'],
    });
    setSecureKey('credential:vercel:api_token', 'test-vercel-token');

    const result = await broker.serverUse({
      service: 'vercel',
      field: 'api_token',
      toolName: 'unpublish_page',
      execute: async () => { throw new Error('should not be called'); },
    });

    expect(result.success).toBe(false);
    expect(result.reason).toContain('not allowed');
  });

  test('denies when no credential metadata exists', async () => {
    const result = await broker.serverUse({
      service: 'vercel',
      field: 'api_token',
      toolName: 'publish_page',
      execute: async () => { throw new Error('should not be called'); },
    });

    expect(result.success).toBe(false);
    expect(result.reason).toContain('No credential found');
  });

  test('denies when credential has no stored value', async () => {
    upsertCredentialMetadata('vercel', 'api_token', {
      allowedTools: ['publish_page'],
    });
    // No setSecureKey — metadata exists but value doesn't

    const result = await broker.serverUse({
      service: 'vercel',
      field: 'api_token',
      toolName: 'publish_page',
      execute: async () => { throw new Error('should not be called'); },
    });

    expect(result.success).toBe(false);
    expect(result.reason).toContain('no stored value');
  });

  test('returns generic error when callback throws (no secret leakage)', async () => {
    upsertCredentialMetadata('vercel', 'api_token', {
      allowedTools: ['publish_page'],
    });
    setSecureKey('credential:vercel:api_token', 'test-vercel-token');

    const result = await broker.serverUse({
      service: 'vercel',
      field: 'api_token',
      toolName: 'publish_page',
      execute: async () => { throw new Error('Vercel API 401: invalid token test-vercel-token'); },
    });

    expect(result.success).toBe(false);
    // The error message must NOT contain the secret
    expect(result.reason).not.toContain('test-vercel-token');
    expect(result.reason).toBe('Credential use failed');
  });

  test('secret value never appears in the result object', async () => {
    upsertCredentialMetadata('vercel', 'api_token', {
      allowedTools: ['publish_page'],
    });
    setSecureKey('credential:vercel:api_token', 'test-vercel-token');

    const result = await broker.serverUse({
      service: 'vercel',
      field: 'api_token',
      toolName: 'publish_page',
      execute: async () => ({ status: 'deployed' }),
    });

    // Serialize the entire result and verify no secret leakage
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('test-vercel-token');
  });

  test('denies when credential has domain restrictions', async () => {
    upsertCredentialMetadata('vercel', 'api_token', {
      allowedTools: ['publish_page'],
      allowedDomains: ['vercel.com'],
    });
    setSecureKey('credential:vercel:api_token', 'test-vercel-token');

    const result = await broker.serverUse({
      service: 'vercel',
      field: 'api_token',
      toolName: 'publish_page',
      execute: async () => { throw new Error('should not be called'); },
    });

    expect(result.success).toBe(false);
    expect(result.reason).toContain('domain restrictions');
    expect(result.reason).toContain('vercel.com');
  });

  test('allows when credential has no domain restrictions', async () => {
    upsertCredentialMetadata('vercel', 'api_token', {
      allowedTools: ['publish_page'],
      allowedDomains: [],
    });
    setSecureKey('credential:vercel:api_token', 'test-vercel-token');

    const result = await broker.serverUse({
      service: 'vercel',
      field: 'api_token',
      toolName: 'publish_page',
      execute: async (token) => {
        expect(token).toBe('test-vercel-token');
        return { ok: true };
      },
    });

    expect(result.success).toBe(true);
    expect(result.result).toEqual({ ok: true });
  });
});
