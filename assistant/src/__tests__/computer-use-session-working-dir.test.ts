import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { CuObservation } from "../daemon/message-protocol.js";
import type { Provider } from "../providers/types.js";

let capturedWorkingDir: string | undefined;

const noopLogger = new Proxy({} as Record<string, unknown>, {
  get: (_target, prop) => (prop === "child" ? () => noopLogger : () => {}),
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const realLogger = require("../util/logger.js");
mock.module("../util/logger.js", () => ({
  ...realLogger,
  getLogger: () => noopLogger,
  getCliLogger: () => noopLogger,
  truncateForLog: (value: string, maxLen = 500) =>
    value.length > maxLen ? value.slice(0, maxLen) + "..." : value,
  initLogger: () => {},
  pruneOldLogFiles: () => 0,
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const realPlatform = require("../util/platform.js");
mock.module("../util/platform.js", () => ({
  ...realPlatform,
  getRootDir: () => "/tmp",
  getDataDir: () => "/tmp/data",

  getSandboxRootDir: () => "/tmp/sandbox",
  getSandboxWorkingDir: () => "/tmp/workspace",
  getInterfacesDir: () => "/tmp/interfaces",
  getWorkspaceDir: () => "/tmp/workspace",
  getWorkspaceConfigPath: () => "/tmp/workspace/config.json",
  getWorkspaceSkillsDir: () => "/tmp/workspace/skills",
  getWorkspaceHooksDir: () => "/tmp/workspace/hooks",
  getWorkspacePromptPath: (file: string) => `/tmp/workspace/${file}`,
  getPlatformName: () => "linux",
  getClipboardCommand: () => null,
  getPidPath: () => "/tmp/test.pid",
  getDbPath: () => "/tmp/data/db/assistant.db",
  getLogPath: () => "/tmp/test.log",
  getHistoryPath: () => "/tmp/data/history",
  getHooksDir: () => "/tmp/hooks",
  readSessionToken: () => null,
  ensureDataDir: () => {},
  isMacOS: () => false,
  isLinux: () => true,
  isWindows: () => false,
  normalizeAssistantId: (id: string) => id,
  readLockfile: () => null,
  writeLockfile: () => {},
}));

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    ui: {},
    daemon: { standaloneRecording: false },
    provider: "mock-provider",
    model: "mock-model",
    permissions: { mode: "workspace" },
    apiKeys: {},
    sandbox: { enabled: false, backend: "native" },
    timeouts: { toolExecutionTimeoutSec: 30, permissionTimeoutSec: 5 },
    skills: { load: { extraDirs: [] } },
    secretDetection: {
      enabled: false,
      allowOneTimeSend: false,
      customPatterns: [],
      entropyThreshold: 3.5,
    },
    contextWindow: {
      enabled: true,
      maxInputTokens: 180000,
      targetBudgetRatio: 0.3,
      compactThreshold: 0.8,
      summaryBudgetRatio: 0.05,
    },
    assistantFeatureFlagValues: {},
  }),
  loadConfig: () => ({}),
  loadRawConfig: () => ({}),
  saveConfig: () => {},
  saveRawConfig: () => {},
  invalidateConfigCache: () => {},
  applyNestedDefaults: (config: unknown) => config,
  getNestedValue: () => undefined,
  setNestedValue: () => {},
  syncConfigToLockfile: () => {},
  API_KEY_PROVIDERS: [],
}));

const { ToolExecutor } = await import("../tools/executor.js");
const { ComputerUseSession } =
  await import("../daemon/computer-use-session.js");

const originalExecute = ToolExecutor.prototype.execute;

describe("ComputerUseSession working directory", () => {
  beforeEach(() => {
    capturedWorkingDir = undefined;
    ToolExecutor.prototype.execute = async function (
      _name: string,
      _input: Record<string, unknown>,
      context: { workingDir: string },
    ) {
      capturedWorkingDir = context.workingDir;
      return { content: "ok", isError: false };
    } as typeof ToolExecutor.prototype.execute;
  });

  afterEach(() => {
    ToolExecutor.prototype.execute = originalExecute;
  });

  test("uses sandbox working directory for tool execution context", async () => {
    let providerCalls = 0;
    const provider: Provider = {
      name: "mock-provider",
      async sendMessage() {
        const calls = providerCalls++;
        if (calls === 0) {
          return {
            content: [
              {
                type: "tool_use",
                id: "toolu_1",
                name: "computer_use_click",
                input: { element_id: 1 },
              },
            ],
            model: "mock-model",
            usage: { inputTokens: 1, outputTokens: 1 },
            stopReason: "tool_use",
          };
        }
        return {
          content: [{ type: "text", text: "unused" }],
          model: "mock-model",
          usage: { inputTokens: 1, outputTokens: 1 },
          stopReason: "end_turn",
        };
      },
    };

    const session = new ComputerUseSession(
      "cu-sandbox-1",
      "test task",
      1440,
      900,
      provider,
      () => {},
    );

    const observation: CuObservation = {
      type: "cu_observation",
      sessionId: "cu-sandbox-1",
      axTree: 'Window "Test" [1]',
    };

    await session.handleObservation(observation);

    expect(capturedWorkingDir).toBe("/tmp/workspace");
  });
});
