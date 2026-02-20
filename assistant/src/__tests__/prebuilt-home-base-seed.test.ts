import { beforeEach, afterAll, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const testDir = mkdtempSync(join(tmpdir(), 'home-base-seed-test-'));

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

import { ensurePrebuiltHomeBaseSeeded, findSeededHomeBaseApp } from '../home-base/prebuilt/seed.js';
import { listApps, getApp, updateApp } from '../memory/app-store.js';

describe('prebuilt home base seed', () => {
  beforeEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    mkdirSync(testDir, { recursive: true });
  });

  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  test('seeds a prebuilt Home Base app and is idempotent', () => {
    const first = ensurePrebuiltHomeBaseSeeded();
    const second = ensurePrebuiltHomeBaseSeeded();

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first!.created).toBe(true);
    expect(second!.created).toBe(false);
    expect(second!.appId).toBe(first!.appId);
    expect(listApps().filter((app) => app.name === 'Home Base').length).toBe(1);
  });

  test('findSeededHomeBaseApp resolves the seeded app', () => {
    const seeded = ensurePrebuiltHomeBaseSeeded();
    expect(seeded).not.toBeNull();
    const found = findSeededHomeBaseApp();

    expect(found).not.toBeNull();
    expect(found?.id).toBe(seeded!.appId);
    // listApps() (used by findSeededHomeBaseApp) no longer stores htmlDefinition
    // in the JSON file — it is persisted as index.html on disk.
    // Use getApp() to load the full definition including htmlDefinition.
    const fullApp = getApp(found!.id);
    expect(fullApp?.htmlDefinition).toContain('home-base-starter-lane');
  });

  test('rejects updates that remove required Home Base anchors', () => {
    const seeded = ensurePrebuiltHomeBaseSeeded();
    expect(seeded).not.toBeNull();

    expect(() => {
      updateApp(seeded!.appId, {
        htmlDefinition: '<main id="home-base-root"></main>',
      });
    }).toThrow('missing required anchors');
  });
});
