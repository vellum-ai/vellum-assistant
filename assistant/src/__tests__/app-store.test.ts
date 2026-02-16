import { describe, test, expect, beforeEach, afterAll, mock } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const testDir = mkdtempSync(join(tmpdir(), 'app-store-test-'));

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
}));

mock.module('../util/logger.js', () => ({
  getLogger: () => new Proxy({} as Record<string, unknown>, {
    get: () => () => {},
  }),
}));

import {
  createApp,
  getApp,
  listApps,
  deleteApp,
  createAppRecord,
  queryAppRecords,
  updateAppRecord,
  getOrCreateHomeBase,
  HOME_BASE_APP_ID,
  type HomeBaseData,
} from '../memory/app-store.js';

afterAll(() => {
  try { rmSync(testDir, { recursive: true }); } catch { /* best effort */ }
});

describe('app-store basic operations', () => {
  test('creates and retrieves an app', () => {
    const app = createApp({
      name: 'Test App',
      description: 'A test app',
      schemaJson: '{"type":"object"}',
      htmlDefinition: '<html></html>',
    });

    expect(app.id).toBeDefined();
    expect(app.name).toBe('Test App');

    const retrieved = getApp(app.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved?.name).toBe('Test App');
  });

  test('lists all apps', () => {
    const app1 = createApp({
      name: 'App 1',
      schemaJson: '{}',
      htmlDefinition: '<html></html>',
    });

    const app2 = createApp({
      name: 'App 2',
      schemaJson: '{}',
      htmlDefinition: '<html></html>',
    });

    const apps = listApps();
    expect(apps.length).toBeGreaterThanOrEqual(2);
    expect(apps.some(a => a.id === app1.id)).toBe(true);
    expect(apps.some(a => a.id === app2.id)).toBe(true);
  });

  test('deletes an app', () => {
    const app = createApp({
      name: 'To Delete',
      schemaJson: '{}',
      htmlDefinition: '<html></html>',
    });

    deleteApp(app.id);
    expect(getApp(app.id)).toBeNull();
  });
});

describe('app records', () => {
  test('creates and retrieves app records', () => {
    const app = createApp({
      name: 'Record Test',
      schemaJson: '{}',
      htmlDefinition: '<html></html>',
    });

    const record = createAppRecord(app.id, { foo: 'bar', count: 42 });
    expect(record.id).toBeDefined();
    expect(record.appId).toBe(app.id);
    expect(record.data).toEqual({ foo: 'bar', count: 42 });

    const records = queryAppRecords(app.id);
    expect(records.length).toBe(1);
    expect(records[0].id).toBe(record.id);
  });

  test('updates app records', () => {
    const app = createApp({
      name: 'Update Test',
      schemaJson: '{}',
      htmlDefinition: '<html></html>',
    });

    const record = createAppRecord(app.id, { value: 1 });
    const updated = updateAppRecord(app.id, record.id, { value: 2 });

    expect(updated.data).toEqual({ value: 2 });
    expect(updated.updatedAt).toBeGreaterThan(record.createdAt);
  });
});

describe('Home Base reserved app', () => {
  beforeEach(() => {
    // Clean up any existing Home Base app before each test
    try {
      deleteApp(HOME_BASE_APP_ID);
    } catch {
      // App might not exist, that's fine
    }
  });

  test('creates Home Base app on first call', () => {
    const { app, record } = getOrCreateHomeBase();

    expect(app.id).toBe(HOME_BASE_APP_ID);
    expect(app.name).toBe('Home Base');
    expect(app.icon).toBe('🏠');
    expect(record.appId).toBe(HOME_BASE_APP_ID);

    // Verify default data structure
    const data = record.data as unknown as HomeBaseData;
    expect(data.theme).toBeDefined();
    expect(data.starterTasks).toBeDefined();
    expect(data.starterTasks.length).toBe(3);
    expect(data.deferredPermissionTasks).toBeDefined();
    expect(data.locale).toBeDefined();
    expect(data.weatherConfig).toBeDefined();
    expect(data.weatherConfig.enabled).toBe(false);
  });

  test('is idempotent - returns existing Home Base on subsequent calls', () => {
    const first = getOrCreateHomeBase();
    const second = getOrCreateHomeBase();

    expect(first.app.id).toBe(second.app.id);
    expect(first.record.id).toBe(second.record.id);
    expect(first.app.createdAt).toBe(second.app.createdAt);
  });

  test('preserves Home Base state across calls', () => {
    const { app, record } = getOrCreateHomeBase();

    // Update the Home Base record
    const updatedData: HomeBaseData = {
      theme: {
        accentColor: '#6366f1',
        accentColorName: 'Indigo',
      },
      starterTasks: [
        { id: 'make_it_yours', status: 'done' },
        { id: 'research_topic', status: 'in_progress' },
        { id: 'research_to_ui', status: 'pending' },
      ],
      deferredPermissionTasks: [],
      locale: {
        city: 'San Francisco',
        region: 'CA',
        country: 'US',
        timezone: 'America/Los_Angeles',
      },
      weatherConfig: {
        enabled: true,
        location: 'San Francisco, CA',
      },
    };

    updateAppRecord(app.id, record.id, updatedData as unknown as Record<string, unknown>);

    // Call getOrCreateHomeBase again
    const { record: retrievedRecord } = getOrCreateHomeBase();
    const data = retrievedRecord.data as unknown as HomeBaseData;

    expect(data.theme.accentColor).toBe('#6366f1');
    expect(data.theme.accentColorName).toBe('Indigo');
    expect(data.starterTasks[0].status).toBe('done');
    expect(data.locale.city).toBe('San Francisco');
    expect(data.weatherConfig.enabled).toBe(true);
  });

  test('has deterministic ID', () => {
    const { app } = getOrCreateHomeBase();
    expect(app.id).toBe('__home_base__');
  });

  test('includes all required schema fields', () => {
    const { record } = getOrCreateHomeBase();
    const data = record.data as unknown as HomeBaseData;

    // Check all required fields exist
    expect(data).toHaveProperty('theme');
    expect(data).toHaveProperty('starterTasks');
    expect(data).toHaveProperty('deferredPermissionTasks');
    expect(data).toHaveProperty('locale');
    expect(data).toHaveProperty('weatherConfig');

    // Check starter tasks structure
    expect(Array.isArray(data.starterTasks)).toBe(true);
    data.starterTasks.forEach(task => {
      expect(task).toHaveProperty('id');
      expect(task).toHaveProperty('status');
      expect(['pending', 'in_progress', 'done', 'deferred_to_dashboard']).toContain(task.status);
    });

    // Check weather config structure
    expect(data.weatherConfig).toHaveProperty('enabled');
    expect(typeof data.weatherConfig.enabled).toBe('boolean');
  });

  test('starter tasks have correct default values', () => {
    const { record } = getOrCreateHomeBase();
    const data = record.data as unknown as HomeBaseData;

    const taskIds = data.starterTasks.map(t => t.id);
    expect(taskIds).toContain('make_it_yours');
    expect(taskIds).toContain('research_topic');
    expect(taskIds).toContain('research_to_ui');

    // All tasks should start as pending
    data.starterTasks.forEach(task => {
      expect(task.status).toBe('pending');
    });
  });
});
