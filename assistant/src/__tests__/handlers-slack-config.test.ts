import { mkdtempSync } from "node:fs";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, mock, test } from "bun:test";

const testDir = mkdtempSync(join(tmpdir(), "handlers-slack-cfg-test-"));

// Track loadRawConfig / saveRawConfig calls
let rawConfigStore: Record<string, unknown> = {};
const saveRawConfigCalls: Record<string, unknown>[] = [];

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    ui: {},
  }),
  loadConfig: () => ({}),
  loadRawConfig: () => ({ ...rawConfigStore }),
  saveRawConfig: (cfg: Record<string, unknown>) => {
    saveRawConfigCalls.push(cfg);
    rawConfigStore = { ...cfg };
  },
  saveConfig: () => {},
  invalidateConfigCache: () => {},
}));

mock.module("../util/platform.js", () => ({
  getRootDir: () => testDir,
  getDataDir: () => testDir,
  getIpcBlobDir: () => join(testDir, "ipc-blobs"),
  isMacOS: () => process.platform === "darwin",
  isLinux: () => process.platform === "linux",
  isWindows: () => process.platform === "win32",
  getSocketPath: () => join(testDir, "test.sock"),
  getPidPath: () => join(testDir, "test.pid"),
  getDbPath: () => join(testDir, "test.db"),
  getLogPath: () => join(testDir, "test.log"),
  ensureDataDir: () => {},
}));

mock.module("../util/logger.js", () => ({
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

import { handleMessage, type HandlerContext } from "../daemon/handlers.js";
import type {
  ServerMessage,
  SlackWebhookConfigRequest,
} from "../daemon/ipc-contract.js";
import { DebouncerMap } from "../util/debounce.js";

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
    send: (_socket, msg) => {
      sent.push(msg);
    },
    broadcast: () => {},
    clearAllSessions: () => 0,
    getOrCreateSession: () => {
      throw new Error("not implemented");
    },
    touchSession: () => {},
  };
  return { ctx, sent };
}

describe("Slack handlers use workspace config (not hardcoded path)", () => {
  test("slack_webhook_config get reads from loadRawConfig", () => {
    rawConfigStore = { slackWebhookUrl: "https://hooks.slack.com/test" };
    saveRawConfigCalls.length = 0;

    const msg: SlackWebhookConfigRequest = {
      type: "slack_webhook_config",
      action: "get",
    };

    const { ctx, sent } = createTestContext();
    handleMessage(msg, {} as net.Socket, ctx);

    expect(sent).toHaveLength(1);
    const res = sent[0] as {
      type: string;
      webhookUrl?: string;
      success: boolean;
    };
    expect(res.type).toBe("slack_webhook_config_response");
    expect(res.success).toBe(true);
    expect(res.webhookUrl).toBe("https://hooks.slack.com/test");
  });

  test("slack_webhook_config set writes via saveRawConfig", () => {
    rawConfigStore = {};
    saveRawConfigCalls.length = 0;

    const msg: SlackWebhookConfigRequest = {
      type: "slack_webhook_config",
      action: "set",
      webhookUrl: "https://hooks.slack.com/new",
    };

    const { ctx, sent } = createTestContext();
    handleMessage(msg, {} as net.Socket, ctx);

    expect(sent).toHaveLength(1);
    const res = sent[0] as { type: string; success: boolean };
    expect(res.type).toBe("slack_webhook_config_response");
    expect(res.success).toBe(true);

    // Verify saveRawConfig was called with the updated webhook URL
    expect(saveRawConfigCalls).toHaveLength(1);
    expect(saveRawConfigCalls[0]!.slackWebhookUrl).toBe(
      "https://hooks.slack.com/new",
    );
  });
});
