import { mkdtempSync } from "node:fs";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "bun:test";
import { mock } from "bun:test";

const testDir = mkdtempSync(join(tmpdir(), "trust-rule-metadata-test-"));
const resolveTestDir = () => process.env.BASE_DATA_DIR ?? testDir;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const realPlatform = require("../util/platform.js");
mock.module("../util/platform.js", () => ({
  ...realPlatform,
  getRootDir: () => resolveTestDir(),
  getDataDir: () => join(resolveTestDir(), "data"),
  getWorkspaceSkillsDir: () => join(resolveTestDir(), "skills"),
  isMacOS: () => process.platform === "darwin",
  isLinux: () => process.platform === "linux",
  isWindows: () => process.platform === "win32",
  getSocketPath: () => join(resolveTestDir(), "test.sock"),
  getPidPath: () => join(resolveTestDir(), "test.pid"),
  getDbPath: () => join(resolveTestDir(), "test.db"),
  getLogPath: () => join(resolveTestDir(), "test.log"),
  ensureDataDir: () => {},
  getIpcBlobDir: () => join(resolveTestDir(), "ipc-blobs"),
}));

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  trace: () => {},
  fatal: () => {},
  child: () => noopLogger,
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const realLogger = require("../util/logger.js");
mock.module("../util/logger.js", () => ({
  ...realLogger,
  getLogger: () => noopLogger,
  getCliLogger: () => noopLogger,
  isDebug: () => false,
  truncateForLog: (value: string) => value,
  initLogger: () => {},
  pruneOldLogFiles: () => 0,
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
import { handleAddTrustRule } from "../daemon/handlers/config.js";
import type { AddTrustRule } from "../daemon/ipc-contract.js";
import type { ServerMessage } from "../daemon/ipc-contract.js";
import {
  clearAllRules,
  clearCache,
  getAllRules,
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

describe("handleAddTrustRule metadata plumbing", () => {
  beforeEach(() => {
    clearAllRules();
    clearCache();
  });

  test("persists allowHighRisk and executionTarget fields when provided", () => {
    const { ctx } = createTestContext();
    const msg: AddTrustRule = {
      type: "add_trust_rule",
      toolName: "bash",
      pattern: "git *",
      scope: "/projects/my-app",
      decision: "allow",
      allowHighRisk: true,
      executionTarget: "host",
    };

    handleAddTrustRule(msg, {} as net.Socket, ctx);

    const rules = getAllRules();
    const userRule = rules.find(
      (r) => r.tool === "bash" && r.pattern === "git *",
    );
    expect(userRule).toBeDefined();
    expect(userRule!.allowHighRisk).toBe(true);
    expect(userRule!.executionTarget).toBe("host");
  });

  test("backward compatibility: rules work without any metadata fields", () => {
    const { ctx } = createTestContext();
    const msg: AddTrustRule = {
      type: "add_trust_rule",
      toolName: "file_write",
      pattern: "**",
      scope: "everywhere",
      decision: "allow",
    };

    handleAddTrustRule(msg, {} as net.Socket, ctx);

    const rules = getAllRules();
    const userRule = rules.find(
      (r) => r.tool === "file_write" && r.pattern === "**",
    );
    expect(userRule).toBeDefined();
    expect(userRule!.decision).toBe("allow");
    // Metadata fields should be absent
    expect(userRule!.allowHighRisk).toBeUndefined();
    expect(userRule!.executionTarget).toBeUndefined();
  });

  test("rule can be retrieved after being added with metadata", () => {
    const { ctx } = createTestContext();
    const msg: AddTrustRule = {
      type: "add_trust_rule",
      toolName: "bash",
      pattern: "npm install *",
      scope: "/projects/web",
      decision: "allow",
      allowHighRisk: false,
      executionTarget: "sandbox",
    };

    handleAddTrustRule(msg, {} as net.Socket, ctx);

    // Force re-read from disk to verify persistence
    clearCache();
    const rules = getAllRules();
    const userRule = rules.find(
      (r) => r.tool === "bash" && r.pattern === "npm install *",
    );
    expect(userRule).toBeDefined();
    expect(userRule!.scope).toBe("/projects/web");
    expect(userRule!.decision).toBe("allow");
    expect(userRule!.allowHighRisk).toBe(false);
    expect(userRule!.executionTarget).toBe("sandbox");
  });

  test("partial metadata: only allowHighRisk is forwarded when others are absent", () => {
    const { ctx } = createTestContext();
    const msg: AddTrustRule = {
      type: "add_trust_rule",
      toolName: "bash",
      pattern: "docker *",
      scope: "everywhere",
      decision: "allow",
      allowHighRisk: true,
    };

    handleAddTrustRule(msg, {} as net.Socket, ctx);

    const rules = getAllRules();
    const userRule = rules.find(
      (r) => r.tool === "bash" && r.pattern === "docker *",
    );
    expect(userRule).toBeDefined();
    expect(userRule!.allowHighRisk).toBe(true);
    expect(userRule!.executionTarget).toBeUndefined();
  });

  test("partial metadata: only executionTarget is forwarded when others are absent", () => {
    const { ctx } = createTestContext();
    const msg: AddTrustRule = {
      type: "add_trust_rule",
      toolName: "bash",
      pattern: "curl *",
      scope: "everywhere",
      decision: "allow",
      executionTarget: "sandbox",
    };

    handleAddTrustRule(msg, {} as net.Socket, ctx);

    const rules = getAllRules();
    const userRule = rules.find(
      (r) => r.tool === "bash" && r.pattern === "curl *",
    );
    expect(userRule).toBeDefined();
    expect(userRule!.executionTarget).toBe("sandbox");
    expect(userRule!.allowHighRisk).toBeUndefined();
  });
});
