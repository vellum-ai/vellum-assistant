import { describe, test, expect, mock } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as net from 'node:net';

const testDir = mkdtempSync(join(tmpdir(), 'handlers-slack-cfg-test-'));

// Track loadRawConfig / saveRawConfig calls
let rawConfigStore: Record<string, unknown> = {};
const saveRawConfigCalls: Record<string, unknown>[] = [];

mock.module('../config/loader.js', () => ({
  getConfig: () => ({}),
  loadConfig: () => ({}),
  loadRawConfig: () => ({ ...rawConfigStore }),
  saveRawConfig: (cfg: Record<string, unknown>) => {
    saveRawConfigCalls.push(cfg);
    rawConfigStore = { ...cfg };
  },
  saveConfig: () => {},
  invalidateConfigCache: () => {},
}));

mock.module('../util/platform.js', () => ({
  getRootDir: () => testDir,
  getDataDir: () => testDir,
  getIpcBlobDir: () => join(testDir, 'ipc-blobs'),
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
  getLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    trace: () => {},
    fatal: () => {},
    child: () => ({
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    }),
  }),
}));

// Mock app-store so getApp returns a fake app for share tests
mock.module('../memory/app-store.js', () => ({
  queryAppRecords: () => [],
  createAppRecord: () => {},
  updateAppRecord: () => {},
  deleteAppRecord: () => {},
  listApps: () => [],
  getApp: (id: string) =>
    id === 'test-app'
      ? { id: 'test-app', name: 'Test App', description: 'A test app' }
      : undefined,
  createApp: () => {},
  updateApp: () => {},
}));

// Mock Slack webhook poster
const postedWebhooks: { url: string; name: string }[] = [];
mock.module('../slack/slack-webhook.js', () => ({
  postToSlackWebhook: async (url: string, name: string) => {
    postedWebhooks.push({ url, name });
  },
}));

import { handleMessage, type HandlerContext } from '../daemon/handlers.js';
import type {
  SlackWebhookConfigRequest,
  ShareToSlackRequest,
  ServerMessage,
} from '../daemon/ipc-contract.js';
import { DebouncerMap } from '../util/debounce.js';

function createTestContext(): { ctx: HandlerContext; sent: ServerMessage[] } {
  const sent: ServerMessage[] = [];
  const ctx: HandlerContext = {
    sessions: new Map(),
    socketToSession: new Map(),
    cuSessions: new Map(),
    socketToCuSession: new Map(),
    cuObservationParseSequence: new Map(),
    socketSandboxOverride: new Map(),
    sharedRequestTimestamps: [],
    debounceTimers: new DebouncerMap({ defaultDelayMs: 200 }),
    suppressConfigReload: false,
    setSuppressConfigReload: () => {},
    updateConfigFingerprint: () => {},
    send: (_socket, msg) => { sent.push(msg); },
    broadcast: () => {},
    clearAllSessions: () => 0,
    getOrCreateSession: () => { throw new Error('not implemented'); },
    touchSession: () => {},
  };
  return { ctx, sent };
}

describe('Slack handlers use workspace config (not hardcoded path)', () => {
  test('slack_webhook_config get reads from loadRawConfig', () => {
    rawConfigStore = { slackWebhookUrl: 'https://hooks.slack.com/test' };
    saveRawConfigCalls.length = 0;

    const msg: SlackWebhookConfigRequest = {
      type: 'slack_webhook_config',
      action: 'get',
    };

    const { ctx, sent } = createTestContext();
    handleMessage(msg, {} as net.Socket, ctx);

    expect(sent).toHaveLength(1);
    const res = sent[0] as { type: string; webhookUrl?: string; success: boolean };
    expect(res.type).toBe('slack_webhook_config_response');
    expect(res.success).toBe(true);
    expect(res.webhookUrl).toBe('https://hooks.slack.com/test');
  });

  test('slack_webhook_config set writes via saveRawConfig', () => {
    rawConfigStore = {};
    saveRawConfigCalls.length = 0;

    const msg: SlackWebhookConfigRequest = {
      type: 'slack_webhook_config',
      action: 'set',
      webhookUrl: 'https://hooks.slack.com/new',
    };

    const { ctx, sent } = createTestContext();
    handleMessage(msg, {} as net.Socket, ctx);

    expect(sent).toHaveLength(1);
    const res = sent[0] as { type: string; success: boolean };
    expect(res.type).toBe('slack_webhook_config_response');
    expect(res.success).toBe(true);

    // Verify saveRawConfig was called with the updated webhook URL
    expect(saveRawConfigCalls).toHaveLength(1);
    expect(saveRawConfigCalls[0]!.slackWebhookUrl).toBe('https://hooks.slack.com/new');
  });

  test('share_to_slack reads webhook URL from loadRawConfig', async () => {
    rawConfigStore = { slackWebhookUrl: 'https://hooks.slack.com/share' };
    postedWebhooks.length = 0;

    const msg: ShareToSlackRequest = {
      type: 'share_to_slack',
      appId: 'test-app',
    };

    const { ctx, sent } = createTestContext();
    await handleMessage(msg, {} as net.Socket, ctx);

    // Wait a tick for async handler to complete
    await new Promise((r) => setTimeout(r, 50));

    const res = sent.find(
      (m) => (m as { type: string }).type === 'share_to_slack_response',
    ) as { type: string; success: boolean } | undefined;
    expect(res).toBeDefined();
    expect(res!.success).toBe(true);

    // Verify the webhook was posted with the URL from loadRawConfig
    expect(postedWebhooks).toHaveLength(1);
    expect(postedWebhooks[0]!.url).toBe('https://hooks.slack.com/share');
    expect(postedWebhooks[0]!.name).toBe('Test App');
  });

  test('share_to_slack fails gracefully when no webhook URL configured', async () => {
    rawConfigStore = {};

    const msg: ShareToSlackRequest = {
      type: 'share_to_slack',
      appId: 'test-app',
    };

    const { ctx, sent } = createTestContext();
    await handleMessage(msg, {} as net.Socket, ctx);

    await new Promise((r) => setTimeout(r, 50));

    const res = sent.find(
      (m) => (m as { type: string }).type === 'share_to_slack_response',
    ) as { type: string; success: boolean; error?: string } | undefined;
    expect(res).toBeDefined();
    expect(res!.success).toBe(false);
    expect(res!.error).toContain('No Slack webhook URL configured');
  });
});
