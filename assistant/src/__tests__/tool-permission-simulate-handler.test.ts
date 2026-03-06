import { mkdtempSync } from "node:fs";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, mock, test } from "bun:test";

const testDir = mkdtempSync(join(tmpdir(), "permsim-handler-test-"));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const realPlatform = require("../util/platform.js");
mock.module("../util/platform.js", () => ({
  ...realPlatform,
  getRootDir: () => testDir,
  getDataDir: () => join(testDir, "data"),
  getWorkspaceSkillsDir: () => join(testDir, "skills"),
  isMacOS: () => process.platform === "darwin",
  isLinux: () => process.platform === "linux",
  isWindows: () => process.platform === "win32",
  getSocketPath: () => join(testDir, "test.sock"),
  getPidPath: () => join(testDir, "test.pid"),
  getDbPath: () => join(testDir, "test.db"),
  getLogPath: () => join(testDir, "test.log"),
  ensureDataDir: () => {},
  getIpcBlobDir: () => join(testDir, "ipc-blobs"),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const realLogger = require("../util/logger.js");
mock.module("../util/logger.js", () => ({
  ...realLogger,
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

const testConfig: Record<string, any> = {
  permissions: { mode: "workspace" as "strict" | "workspace" },
  skills: { load: { extraDirs: [] as string[] } },
  sandbox: { enabled: true },
};

mock.module("../config/loader.js", () => ({
  getConfig: () => testConfig,
  loadConfig: () => testConfig,
  invalidateConfigCache: () => {},
  saveConfig: () => {},
  loadRawConfig: () => ({}),
  saveRawConfig: () => {},
  getNestedValue: () => undefined,
  setNestedValue: () => {},
}));

import type { HandlerContext } from "../daemon/handlers.js";
import { handleToolPermissionSimulate } from "../daemon/handlers/config.js";
import type {
  ServerMessage,
  ToolPermissionSimulateRequest,
  ToolPermissionSimulateResponse,
} from "../daemon/ipc-contract.js";
import {
  addRule,
  clearAllRules,
  clearCache,
} from "../permissions/trust-store.js";
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

function getResponse(sent: ServerMessage[]): ToolPermissionSimulateResponse {
  const msg = sent.find(
    (m) => (m as any).type === "tool_permission_simulate_response",
  );
  if (!msg)
    throw new Error(
      "No tool_permission_simulate_response found in sent messages",
    );
  return msg as unknown as ToolPermissionSimulateResponse;
}

describe("tool_permission_simulate handler", () => {
  beforeEach(() => {
    clearAllRules();
    clearCache();
    testConfig.permissions.mode = "workspace";
  });

  test("validation: returns error when toolName is missing", async () => {
    const { ctx, sent } = createTestContext();
    const msg = {
      type: "tool_permission_simulate",
    } as any as ToolPermissionSimulateRequest;
    await handleToolPermissionSimulate(msg, {} as net.Socket, ctx);

    const res = getResponse(sent);
    expect(res.success).toBe(false);
    expect(res.error).toContain("toolName is required");
  });

  test("validation: returns error when input is missing", async () => {
    const { ctx, sent } = createTestContext();
    const msg = {
      type: "tool_permission_simulate",
      toolName: "bash",
    } as any as ToolPermissionSimulateRequest;
    await handleToolPermissionSimulate(msg, {} as net.Socket, ctx);

    const res = getResponse(sent);
    expect(res.success).toBe(false);
    expect(res.error).toContain("input is required");
  });

  test("low-risk auto-allow: file_read is auto-allowed", async () => {
    const { ctx, sent } = createTestContext();
    const msg: ToolPermissionSimulateRequest = {
      type: "tool_permission_simulate",
      toolName: "file_read",
      input: { path: "/tmp/test.txt" },
    };
    await handleToolPermissionSimulate(msg, {} as net.Socket, ctx);

    const res = getResponse(sent);
    expect(res.success).toBe(true);
    expect(res.decision).toBe("allow");
    expect(res.riskLevel).toBe("low");
  });

  test("deny rule produces deny decision", async () => {
    // file_write deny rule — no default allow-all rule competes
    addRule("file_write", "file_write:/tmp/**", "everywhere", "deny");

    const { ctx, sent } = createTestContext();
    const msg: ToolPermissionSimulateRequest = {
      type: "tool_permission_simulate",
      toolName: "file_write",
      input: { path: "/tmp/test.txt", content: "hello" },
    };
    await handleToolPermissionSimulate(msg, {} as net.Socket, ctx);

    const res = getResponse(sent);
    expect(res.success).toBe(true);
    expect(res.decision).toBe("deny");
    expect(res.matchedRuleId).toBeDefined();
  });

  test("prompt decision includes allowlist and scope options", async () => {
    const { ctx, sent } = createTestContext();
    // file_write is medium risk and will prompt without a trust rule
    const msg: ToolPermissionSimulateRequest = {
      type: "tool_permission_simulate",
      toolName: "file_write",
      input: { path: "/tmp/test.txt", content: "hello" },
    };
    await handleToolPermissionSimulate(msg, {} as net.Socket, ctx);

    const res = getResponse(sent);
    expect(res.success).toBe(true);
    expect(res.decision).toBe("prompt");
    expect(res.promptPayload).toBeDefined();
    expect(res.promptPayload!.allowlistOptions.length).toBeGreaterThan(0);
    expect(res.promptPayload!.scopeOptions.length).toBeGreaterThan(0);
    expect(res.promptPayload!.persistentDecisionsAllowed).toBe(true);
  });

  test("proxied bash is not special-cased (follows normal rules)", async () => {
    const { ctx, sent } = createTestContext();
    const msg: ToolPermissionSimulateRequest = {
      type: "tool_permission_simulate",
      toolName: "bash",
      input: { command: "curl https://example.com", network_mode: "proxied" },
    };
    await handleToolPermissionSimulate(msg, {} as net.Socket, ctx);

    const res = getResponse(sent);
    expect(res.success).toBe(true);
    // Proxied bash now follows normal permission rules — the default
    // allow-bash rule auto-allows low-risk commands just like non-proxied bash.
    expect(res.decision).toBe("allow");
  });

  test("forcePromptSideEffects promotes allow to prompt for side-effect tools", async () => {
    // file_read is low-risk, auto-allowed, and NOT a side-effect tool
    // so we use bash with an allow rule to test the promotion
    addRule("bash", "bash:ls*", "everywhere", "allow");

    const { ctx, sent } = createTestContext();
    const msg: ToolPermissionSimulateRequest = {
      type: "tool_permission_simulate",
      toolName: "bash",
      input: { command: "ls" },
      forcePromptSideEffects: true,
    };
    await handleToolPermissionSimulate(msg, {} as net.Socket, ctx);

    const res = getResponse(sent);
    expect(res.success).toBe(true);
    // bash is a side-effect tool, so allow gets promoted to prompt
    expect(res.decision).toBe("prompt");
    expect(res.reason).toContain("Private thread");
  });

  test("forcePromptSideEffects does not affect non-side-effect tools", async () => {
    const { ctx, sent } = createTestContext();
    // file_read is low-risk and not a side-effect tool
    const msg: ToolPermissionSimulateRequest = {
      type: "tool_permission_simulate",
      toolName: "file_read",
      input: { path: "/tmp/test.txt" },
      forcePromptSideEffects: true,
    };
    await handleToolPermissionSimulate(msg, {} as net.Socket, ctx);

    const res = getResponse(sent);
    expect(res.success).toBe(true);
    expect(res.decision).toBe("allow");
  });

  test("non-interactive converts prompt to deny", async () => {
    const { ctx, sent } = createTestContext();
    // file_write is medium risk → prompt without a rule
    const msg: ToolPermissionSimulateRequest = {
      type: "tool_permission_simulate",
      toolName: "file_write",
      input: { path: "/tmp/test.txt", content: "hello" },
      isInteractive: false,
    };
    await handleToolPermissionSimulate(msg, {} as net.Socket, ctx);

    const res = getResponse(sent);
    expect(res.success).toBe(true);
    expect(res.decision).toBe("deny");
    expect(res.reason).toContain("Non-interactive");
    // No prompt payload when decision is deny
    expect(res.promptPayload).toBeUndefined();
  });

  test("non-interactive does not affect allow decisions", async () => {
    const { ctx, sent } = createTestContext();
    const msg: ToolPermissionSimulateRequest = {
      type: "tool_permission_simulate",
      toolName: "file_read",
      input: { path: "/tmp/test.txt" },
      isInteractive: false,
    };
    await handleToolPermissionSimulate(msg, {} as net.Socket, ctx);

    const res = getResponse(sent);
    expect(res.success).toBe(true);
    expect(res.decision).toBe("allow");
  });

  test("allow rule with matching pattern returns allow", async () => {
    addRule("file_write", "file_write:/tmp/**", "everywhere", "allow");

    const { ctx, sent } = createTestContext();
    const msg: ToolPermissionSimulateRequest = {
      type: "tool_permission_simulate",
      toolName: "file_write",
      input: { path: "/tmp/test.txt", content: "hello" },
    };
    await handleToolPermissionSimulate(msg, {} as net.Socket, ctx);

    const res = getResponse(sent);
    expect(res.success).toBe(true);
    expect(res.decision).toBe("allow");
    expect(res.matchedRuleId).toBeDefined();
  });

  test("executionTarget: sandbox-scoped rule matches when tool resolves to sandbox", async () => {
    // file_write resolves to 'sandbox' (no host_ prefix)
    addRule("file_write", "file_write:/tmp/**", "everywhere", "allow", 100, {
      executionTarget: "sandbox",
    });

    const { ctx, sent } = createTestContext();
    const msg: ToolPermissionSimulateRequest = {
      type: "tool_permission_simulate",
      toolName: "file_write",
      input: { path: "/tmp/test.txt", content: "hello" },
    };
    await handleToolPermissionSimulate(msg, {} as net.Socket, ctx);

    const res = getResponse(sent);
    expect(res.success).toBe(true);
    expect(res.decision).toBe("allow");
    expect(res.matchedRuleId).toBeDefined();
    expect(res.executionTarget).toBe("sandbox");
  });

  test("executionTarget: sandbox-scoped rule does NOT match when tool resolves to host", async () => {
    // host_file_write resolves to 'host' (host_ prefix)
    addRule(
      "host_file_write",
      "host_file_write:/tmp/**",
      "everywhere",
      "allow",
      100,
      {
        executionTarget: "sandbox",
      },
    );

    const { ctx, sent } = createTestContext();
    const msg: ToolPermissionSimulateRequest = {
      type: "tool_permission_simulate",
      toolName: "host_file_write",
      input: { path: "/tmp/test.txt", content: "hello" },
    };
    await handleToolPermissionSimulate(msg, {} as net.Socket, ctx);

    const res = getResponse(sent);
    expect(res.success).toBe(true);
    // The sandbox-scoped allow rule should not match a host tool — falls
    // through to the default ask rule instead.
    expect(res.decision).toBe("prompt");
    expect(res.executionTarget).toBe("host");
  });

  test("executionTarget: response includes resolved execution target", async () => {
    const { ctx, sent } = createTestContext();
    const msg: ToolPermissionSimulateRequest = {
      type: "tool_permission_simulate",
      toolName: "host_bash",
      input: { command: "echo hi" },
    };
    await handleToolPermissionSimulate(msg, {} as net.Socket, ctx);

    const res = getResponse(sent);
    expect(res.success).toBe(true);
    expect(res.executionTarget).toBe("host");
  });
});
