/**
 * Tests for the public-ingress ngrok auth endpoint.
 *
 * Verifies that POST /v1/integrations/public-ingress/ngrok/auth resolves
 * the auth token from secure storage, runs ngrok config server-side,
 * and persists body-provided tokens.
 */

import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';

const testDir = realpathSync(mkdtempSync(join(tmpdir(), 'ngrok-auth-test-')));

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
  getWorkspaceConfigPath: () => join(testDir, 'config.json'),
  getWorkspaceDir: () => testDir,
  migrateToDataLayout: () => {},
  migrateToWorkspaceLayout: () => {},
}));

mock.module('../util/logger.js', () => ({
  getLogger: () => new Proxy({} as Record<string, unknown>, { get: () => () => {} }),
  isDebug: () => false,
  truncateForLog: (v: string) => v,
}));

// Mock secure keys storage
const secureStore = new Map<string, string>();
let setSecureKeyShouldFail = false;
mock.module('../security/secure-keys.js', () => ({
  getSecureKey: (key: string) => secureStore.get(key),
  setSecureKey: (key: string, value: string) => {
    if (setSecureKeyShouldFail) return false;
    secureStore.set(key, value);
    return true;
  },
  deleteSecureKey: (key: string) => secureStore.delete(key),
}));

// Track metadata upserts
const metadataUpserts: Array<{ service: string; field: string }> = [];
mock.module('../tools/credentials/metadata-store.js', () => ({
  upsertCredentialMetadata: (service: string, field: string) => {
    metadataUpserts.push({ service, field });
  },
  deleteCredentialMetadata: () => {},
}));

// Mock Bun.spawn to simulate ngrok command execution
let spawnExitCode = 0;
let spawnArgs: string[] = [];
const originalBunSpawn = Bun.spawn;
// @ts-expect-error - overriding Bun.spawn for test
Bun.spawn = (cmd: string[], opts?: Record<string, unknown>) => {
  spawnArgs = cmd;
  const exitPromise = Promise.resolve(spawnExitCode);
  return {
    exited: exitPromise,
    stdout: new ReadableStream({ start(ctrl) { ctrl.close(); } }),
    stderr: spawnExitCode === 0
      ? new ReadableStream({ start(ctrl) { ctrl.close(); } })
      : new ReadableStream({
          start(ctrl) {
            ctrl.enqueue(new TextEncoder().encode('ngrok error'));
            ctrl.close();
          },
        }),
    pid: 12345,
    kill: () => {},
  };
};

const { handleNgrokAuth } = await import('../runtime/routes/ngrok-routes.js');

// Ensure metadata directory exists
mkdirSync(join(testDir, 'credentials'), { recursive: true });
writeFileSync(join(testDir, 'credentials', 'metadata.json'), JSON.stringify({ version: 2, credentials: {} }));

afterAll(() => {
  // @ts-expect-error - restoring Bun.spawn
  Bun.spawn = originalBunSpawn;
  rmSync(testDir, { recursive: true, force: true });
});

beforeEach(() => {
  secureStore.clear();
  metadataUpserts.length = 0;
  spawnExitCode = 0;
  spawnArgs = [];
  setSecureKeyShouldFail = false;
});

describe('ngrok auth endpoint', () => {
  test('body token path: configures ngrok and persists to secure storage', async () => {
    const req = new Request('http://localhost/v1/integrations/public-ingress/ngrok/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ authToken: 'ngrok_token_123' }),
    });

    const res = await handleNgrokAuth(req);
    const data = await res.json() as { success: boolean; hasToken: boolean; source: string };

    expect(data.success).toBe(true);
    expect(data.hasToken).toBe(true);
    expect(data.source).toBe('body');
    expect(spawnArgs).toEqual(['ngrok', 'config', 'add-authtoken', 'ngrok_token_123']);
    expect(secureStore.get('credential:ngrok:authtoken')).toBe('ngrok_token_123');
    expect(metadataUpserts).toContainEqual({ service: 'ngrok', field: 'authtoken' });
  });

  test('stored-token path: resolves from secure storage', async () => {
    secureStore.set('credential:ngrok:authtoken', 'stored_ngrok_token');

    const req = new Request('http://localhost/v1/integrations/public-ingress/ngrok/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    const res = await handleNgrokAuth(req);
    const data = await res.json() as { success: boolean; hasToken: boolean; source: string };

    expect(data.success).toBe(true);
    expect(data.hasToken).toBe(true);
    expect(data.source).toBe('secure_storage');
    expect(spawnArgs).toEqual(['ngrok', 'config', 'add-authtoken', 'stored_ngrok_token']);
  });

  test('missing token failure: returns 400 with clear guidance', async () => {
    const req = new Request('http://localhost/v1/integrations/public-ingress/ngrok/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    const res = await handleNgrokAuth(req);
    const data = await res.json() as { success: boolean; error: string; hasToken: boolean };

    expect(res.status).toBe(400);
    expect(data.success).toBe(false);
    expect(data.hasToken).toBe(false);
    expect(data.error).toContain('credential_store');
  });

  test('ngrok command failure is surfaced', async () => {
    spawnExitCode = 1;

    const req = new Request('http://localhost/v1/integrations/public-ingress/ngrok/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ authToken: 'bad_token' }),
    });

    const res = await handleNgrokAuth(req);
    const data = await res.json() as { success: boolean; error: string };

    expect(data.success).toBe(false);
    expect(data.error).toContain('ngrok config add-authtoken failed');
  });

  test('setSecureKey failure returns success with warning', async () => {
    setSecureKeyShouldFail = true;

    const req = new Request('http://localhost/v1/integrations/public-ingress/ngrok/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ authToken: 'ngrok_token_456' }),
    });

    const res = await handleNgrokAuth(req);
    const data = await res.json() as { success: boolean; hasToken: boolean; source: string; warning?: string };

    expect(data.success).toBe(true);
    expect(data.hasToken).toBe(true);
    expect(data.source).toBe('body');
    expect(data.warning).toBeDefined();
    expect(data.warning).toContain('could not be persisted');
    // Token should not be in the store since setSecureKey failed
    expect(secureStore.has('credential:ngrok:authtoken')).toBe(false);
    // Metadata should not be upserted since storage failed
    expect(metadataUpserts).not.toContainEqual({ service: 'ngrok', field: 'authtoken' });
  });

  test('body-provided token is not persisted when ngrok command fails', async () => {
    spawnExitCode = 1;

    const req = new Request('http://localhost/v1/integrations/public-ingress/ngrok/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ authToken: 'fail_token' }),
    });

    await handleNgrokAuth(req);

    // Token should not be persisted since the command failed
    expect(secureStore.has('credential:ngrok:authtoken')).toBe(false);
  });
});
