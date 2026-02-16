import { describe, test, expect, beforeEach, afterAll, mock } from 'bun:test';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const testDir = mkdtempSync(join(tmpdir(), 'home-base-bootstrap-test-'));

mock.module('../util/platform.js', () => ({
  getDataDir: () => testDir,
  getWorkspaceDir: () => testDir,
  isMacOS: () => process.platform === 'darwin',
  isLinux: () => process.platform === 'linux',
  isWindows: () => process.platform === 'win32',
  getSocketPath: () => join(testDir, 'test.sock'),
  getPidPath: () => join(testDir, 'test.pid'),
  getDbPath: () => join(testDir, 'test.db'),
  getLogPath: () => join(testDir, 'test.log'),
  ensureDataDir: () => {},
  getInterfacesDir: () => join(testDir, 'interfaces'),
  getWorkspaceSkillsDir: () => join(testDir, 'skills'),
  getWorkspacePromptPath: (filename: string) => join(testDir, filename),
}));

mock.module('../util/logger.js', () => ({
  getLogger: () => new Proxy({} as Record<string, unknown>, {
    get: () => () => {},
  }),
}));

import {
  getOrCreateHomeBase,
  HOME_BASE_APP_ID,
  getApp,
  queryAppRecords,
  deleteApp,
  updateAppRecord,
  type HomeBaseData,
} from '../memory/app-store.js';

afterAll(() => {
  try { rmSync(testDir, { recursive: true }); } catch { /* best effort */ }
});

describe('Home Base bootstrap idempotence', () => {
  beforeEach(() => {
    // Clean up any existing Home Base app before each test
    try {
      deleteApp(HOME_BASE_APP_ID);
    } catch {
      // App might not exist, that's fine
    }
  });

  test('first-run bootstrap creates app and default record', () => {
    // Verify Home Base doesn't exist
    expect(getApp(HOME_BASE_APP_ID)).toBeNull();

    // Bootstrap
    const { app, record } = getOrCreateHomeBase();

    // Verify app was created
    expect(app).toBeDefined();
    expect(app.id).toBe(HOME_BASE_APP_ID);
    expect(app.name).toBe('Home Base');

    // Verify record was created with defaults
    expect(record).toBeDefined();
    expect(record.appId).toBe(HOME_BASE_APP_ID);

    const data = record.data as unknown as HomeBaseData;
    expect(data.starterTasks.length).toBe(3);
    expect(data.weatherConfig.enabled).toBe(false);
  });

  test('restart bootstrap is idempotent - preserves existing app', () => {
    // First bootstrap
    const first = getOrCreateHomeBase();
    const firstCreatedAt = first.app.createdAt;
    const firstRecordId = first.record.id;

    // Simulate restart - call bootstrap again
    const second = getOrCreateHomeBase();

    // App should be the same
    expect(second.app.id).toBe(first.app.id);
    expect(second.app.createdAt).toBe(firstCreatedAt);
    expect(second.record.id).toBe(firstRecordId);
  });

  test('restart bootstrap preserves user modifications', () => {
    // First bootstrap
    const { app, record } = getOrCreateHomeBase();

    // User modifies Home Base data
    const modifiedData: HomeBaseData = {
      theme: {
        accentColor: '#ec4899',
        accentColorName: 'Pink',
        cardRadius: '12px',
      },
      starterTasks: [
        { id: 'make_it_yours', status: 'done' },
        { id: 'research_topic', status: 'done' },
        { id: 'research_to_ui', status: 'in_progress' },
      ],
      deferredPermissionTasks: [
        { id: 'microphone_access', status: 'pending' },
      ],
      locale: {
        city: 'Portland',
        region: 'OR',
        country: 'US',
        timezone: 'America/Los_Angeles',
      },
      weatherConfig: {
        enabled: true,
        location: 'Portland, OR',
      },
    };

    updateAppRecord(app.id, record.id, modifiedData as unknown as Record<string, unknown>);

    // Simulate restart - bootstrap again
    const { record: afterRestart } = getOrCreateHomeBase();
    const data = afterRestart.data as unknown as HomeBaseData;

    // All user modifications should be preserved
    expect(data.theme.accentColor).toBe('#ec4899');
    expect(data.theme.accentColorName).toBe('Pink');
    expect(data.theme.cardRadius).toBe('12px');
    expect(data.starterTasks[0].status).toBe('done');
    expect(data.starterTasks[1].status).toBe('done');
    expect(data.starterTasks[2].status).toBe('in_progress');
    expect(data.deferredPermissionTasks.length).toBe(1);
    expect(data.deferredPermissionTasks[0].id).toBe('microphone_access');
    expect(data.locale.city).toBe('Portland');
    expect(data.weatherConfig.enabled).toBe(true);
    expect(data.weatherConfig.location).toBe('Portland, OR');
  });

  test('bootstrap is safe when app exists but no records', () => {
    // Create app manually (simulating partial corruption)
    const firstBootstrap = getOrCreateHomeBase();
    const { app } = firstBootstrap;

    // Delete all records (simulating corruption)
    const records = queryAppRecords(HOME_BASE_APP_ID);
    for (const record of records) {
      const appDir = join(testDir, 'apps', HOME_BASE_APP_ID);
      const recordPath = join(appDir, 'records', `${record.id}.json`);
      if (existsSync(recordPath)) {
        rmSync(recordPath);
      }
    }

    // Verify no records exist
    expect(queryAppRecords(HOME_BASE_APP_ID).length).toBe(0);

    // Bootstrap should recreate the record
    const { app: restoredApp, record: restoredRecord } = getOrCreateHomeBase();

    expect(restoredApp.id).toBe(app.id);
    expect(restoredRecord).toBeDefined();
    expect(restoredRecord.appId).toBe(HOME_BASE_APP_ID);

    const data = restoredRecord.data as unknown as HomeBaseData;
    expect(data.starterTasks.length).toBe(3);
  });

  test('bootstrap handles multiple calls in succession', () => {
    // Rapid successive calls should all be safe
    const results = [
      getOrCreateHomeBase(),
      getOrCreateHomeBase(),
      getOrCreateHomeBase(),
      getOrCreateHomeBase(),
      getOrCreateHomeBase(),
    ];

    // All should return the same app ID and first record ID
    const appIds = results.map(r => r.app.id);
    const recordIds = results.map(r => r.record.id);

    expect(new Set(appIds).size).toBe(1);
    expect(new Set(recordIds).size).toBe(1);
    expect(appIds[0]).toBe(HOME_BASE_APP_ID);
  });

  test('bootstrap creates proper file structure', () => {
    getOrCreateHomeBase();

    const appsDir = join(testDir, 'apps');
    const appFile = join(appsDir, `${HOME_BASE_APP_ID}.json`);
    const recordsDir = join(appsDir, HOME_BASE_APP_ID, 'records');

    expect(existsSync(appFile)).toBe(true);
    expect(existsSync(recordsDir)).toBe(true);

    // Should have exactly one record
    const records = queryAppRecords(HOME_BASE_APP_ID);
    expect(records.length).toBe(1);
  });

  test('bootstrap does not create duplicate records', () => {
    // Multiple bootstrap calls
    getOrCreateHomeBase();
    getOrCreateHomeBase();
    getOrCreateHomeBase();

    // Should still have exactly one record
    const records = queryAppRecords(HOME_BASE_APP_ID);
    expect(records.length).toBe(1);
  });

  test('bootstrap returns correct data types', () => {
    const { app, record } = getOrCreateHomeBase();

    // App fields
    expect(typeof app.id).toBe('string');
    expect(typeof app.name).toBe('string');
    expect(typeof app.schemaJson).toBe('string');
    expect(typeof app.htmlDefinition).toBe('string');
    expect(typeof app.createdAt).toBe('number');
    expect(typeof app.updatedAt).toBe('number');

    // Record fields
    expect(typeof record.id).toBe('string');
    expect(typeof record.appId).toBe('string');
    expect(typeof record.createdAt).toBe('number');
    expect(typeof record.updatedAt).toBe('number');
    expect(typeof record.data).toBe('object');

    // Data structure
    const data = record.data as unknown as HomeBaseData;
    expect(typeof data.theme).toBe('object');
    expect(Array.isArray(data.starterTasks)).toBe(true);
    expect(Array.isArray(data.deferredPermissionTasks)).toBe(true);
    expect(typeof data.locale).toBe('object');
    expect(typeof data.weatherConfig).toBe('object');
    expect(typeof data.weatherConfig.enabled).toBe('boolean');
  });
});

describe('Home Base schema validation', () => {
  beforeEach(() => {
    try {
      deleteApp(HOME_BASE_APP_ID);
    } catch { /* best effort */ }
  });

  test('schema JSON is valid JSON', () => {
    const { app } = getOrCreateHomeBase();

    // Should parse without error
    const schema = JSON.parse(app.schemaJson);
    expect(schema).toBeDefined();
    expect(schema.type).toBe('object');
    expect(schema.properties).toBeDefined();
  });

  test('schema includes all required fields', () => {
    const { app } = getOrCreateHomeBase();
    const schema = JSON.parse(app.schemaJson);

    expect(schema.properties.theme).toBeDefined();
    expect(schema.properties.starterTasks).toBeDefined();
    expect(schema.properties.deferredPermissionTasks).toBeDefined();
    expect(schema.properties.locale).toBeDefined();
    expect(schema.properties.weatherConfig).toBeDefined();

    expect(schema.required).toContain('theme');
    expect(schema.required).toContain('starterTasks');
    expect(schema.required).toContain('deferredPermissionTasks');
    expect(schema.required).toContain('locale');
    expect(schema.required).toContain('weatherConfig');
  });

  test('default data matches schema', () => {
    const { app, record } = getOrCreateHomeBase();
    const schema = JSON.parse(app.schemaJson);
    const data = record.data as unknown as HomeBaseData;

    // Check all required fields exist in data
    schema.required.forEach((field: string) => {
      expect(data).toHaveProperty(field);
    });

    // Check nested schema compliance
    expect(typeof data.weatherConfig.enabled).toBe('boolean');
    expect(Array.isArray(data.starterTasks)).toBe(true);
    expect(Array.isArray(data.deferredPermissionTasks)).toBe(true);
  });
});
