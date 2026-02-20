import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as net from 'node:net';

const testDir = mkdtempSync(join(tmpdir(), 'handlers-twilio-cfg-test-'));

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

mock.module('../memory/app-store.js', () => ({
  queryAppRecords: () => [],
  createAppRecord: () => {},
  updateAppRecord: () => {},
  deleteAppRecord: () => {},
  listApps: () => [],
  getApp: () => undefined,
  createApp: () => {},
  updateApp: () => {},
}));

mock.module('../slack/slack-webhook.js', () => ({
  postToSlackWebhook: async () => {},
}));

import { handleMessage, type HandlerContext } from '../daemon/handlers.js';
import type {
  TwilioWebhookConfigRequest,
  ServerMessage,
} from '../daemon/ipc-contract.js';

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
    debounceTimers: new Map(),
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

describe('Twilio webhook config handler', () => {
  beforeEach(() => {
    rawConfigStore = {};
    saveRawConfigCalls.length = 0;
  });

  test('get returns empty string when no config set', () => {
    rawConfigStore = {};

    const msg: TwilioWebhookConfigRequest = {
      type: 'twilio_webhook_config',
      action: 'get',
    };

    const { ctx, sent } = createTestContext();
    handleMessage(msg, {} as net.Socket, ctx);

    expect(sent).toHaveLength(1);
    const res = sent[0] as { type: string; webhookBaseUrl: string; success: boolean };
    expect(res.type).toBe('twilio_webhook_config_response');
    expect(res.success).toBe(true);
    expect(res.webhookBaseUrl).toBe('');
  });

  test('set persists value and returns it', () => {
    rawConfigStore = {};

    const msg: TwilioWebhookConfigRequest = {
      type: 'twilio_webhook_config',
      action: 'set',
      webhookBaseUrl: 'https://example.com/twilio',
    };

    const { ctx, sent } = createTestContext();
    handleMessage(msg, {} as net.Socket, ctx);

    expect(sent).toHaveLength(1);
    const res = sent[0] as { type: string; webhookBaseUrl: string; success: boolean };
    expect(res.type).toBe('twilio_webhook_config_response');
    expect(res.success).toBe(true);
    expect(res.webhookBaseUrl).toBe('https://example.com/twilio');

    expect(saveRawConfigCalls).toHaveLength(1);
    const saved = saveRawConfigCalls[0] as { calls?: { webhookBaseUrl?: string } };
    expect(saved.calls?.webhookBaseUrl).toBe('https://example.com/twilio');
  });

  test('set normalizes trailing slashes', () => {
    rawConfigStore = {};

    const msg: TwilioWebhookConfigRequest = {
      type: 'twilio_webhook_config',
      action: 'set',
      webhookBaseUrl: 'https://example.com/twilio///',
    };

    const { ctx, sent } = createTestContext();
    handleMessage(msg, {} as net.Socket, ctx);

    expect(sent).toHaveLength(1);
    const res = sent[0] as { type: string; webhookBaseUrl: string; success: boolean };
    expect(res.webhookBaseUrl).toBe('https://example.com/twilio');

    const saved = saveRawConfigCalls[0] as { calls?: { webhookBaseUrl?: string } };
    expect(saved.calls?.webhookBaseUrl).toBe('https://example.com/twilio');
  });

  test('set treats empty string as unset', () => {
    rawConfigStore = { calls: { webhookBaseUrl: 'https://example.com/twilio' } };
    saveRawConfigCalls.length = 0;

    const msg: TwilioWebhookConfigRequest = {
      type: 'twilio_webhook_config',
      action: 'set',
      webhookBaseUrl: '',
    };

    const { ctx, sent } = createTestContext();
    handleMessage(msg, {} as net.Socket, ctx);

    expect(sent).toHaveLength(1);
    const res = sent[0] as { type: string; webhookBaseUrl: string; success: boolean };
    expect(res.success).toBe(true);
    expect(res.webhookBaseUrl).toBe('');

    const saved = saveRawConfigCalls[0] as { calls?: { webhookBaseUrl?: string } };
    expect(saved.calls?.webhookBaseUrl).toBeUndefined();
  });

  test('get after set roundtrip works', () => {
    rawConfigStore = {};

    // Set
    const setMsg: TwilioWebhookConfigRequest = {
      type: 'twilio_webhook_config',
      action: 'set',
      webhookBaseUrl: 'https://my-server.ngrok.io',
    };

    const { ctx: setCtx, sent: setSent } = createTestContext();
    handleMessage(setMsg, {} as net.Socket, setCtx);

    expect(setSent).toHaveLength(1);
    const setRes = setSent[0] as { type: string; webhookBaseUrl: string; success: boolean };
    expect(setRes.success).toBe(true);
    expect(setRes.webhookBaseUrl).toBe('https://my-server.ngrok.io');

    // Get (rawConfigStore was updated by the mock saveRawConfig)
    const getMsg: TwilioWebhookConfigRequest = {
      type: 'twilio_webhook_config',
      action: 'get',
    };

    const { ctx: getCtx, sent: getSent } = createTestContext();
    handleMessage(getMsg, {} as net.Socket, getCtx);

    expect(getSent).toHaveLength(1);
    const getRes = getSent[0] as { type: string; webhookBaseUrl: string; success: boolean };
    expect(getRes.type).toBe('twilio_webhook_config_response');
    expect(getRes.success).toBe(true);
    expect(getRes.webhookBaseUrl).toBe('https://my-server.ngrok.io');
  });
});
