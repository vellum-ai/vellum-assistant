// Guard test: assistant CLI commands must always classify as Low risk.
//
// The assistant uses its own CLI tools during normal operation. If these
// commands require user approval, it blocks autonomous assistant workflows.
// See #18982 / #18998 for the regression that motivated this guard.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, mock, test } from "bun:test";

const guardTestDir = mkdtempSync(join(tmpdir(), "cli-risk-guard-test-"));

mock.module("../util/platform.js", () => ({
  getRootDir: () => guardTestDir,
  getDataDir: () => join(guardTestDir, "data"),
  getWorkspaceSkillsDir: () => join(guardTestDir, "skills"),
  isMacOS: () => process.platform === "darwin",
  isLinux: () => process.platform === "linux",
  isWindows: () => process.platform === "win32",
  getPidPath: () => join(guardTestDir, "test.pid"),
  getDbPath: () => join(guardTestDir, "test.db"),
  getLogPath: () => join(guardTestDir, "test.log"),
  ensureDataDir: () => {},
}));

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: (_target: Record<string, unknown>, _prop: string) => {
        return () => {};
      },
    }),
}));

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    permissions: { mode: "workspace" },
    skills: { load: { extraDirs: [] } },
    sandbox: { enabled: true },
  }),
  loadConfig: () => ({}),
  invalidateConfigCache: () => {},
  saveConfig: () => {},
  loadRawConfig: () => ({}),
  saveRawConfig: () => {},
  getNestedValue: () => undefined,
  setNestedValue: () => {},
}));

import { classifyRisk } from "../permissions/checker.js";
import { RiskLevel } from "../permissions/types.js";

/**
 * Assert that a command classifies as Low risk, with a descriptive failure
 * message that guides developers toward the correct fix.
 */
function expectLowRisk(command: string, actual: RiskLevel): void {
  if (actual !== RiskLevel.Low) {
    throw new Error(
      `"${command}" classified as ${actual} instead of Low. ` +
        `assistant CLI commands must always be Low risk — the assistant ` +
        `uses its own CLI during normal operation. If you need risk ` +
        `escalation for specific subcommands, add them to an allowlist ` +
        `in this guard test with justification.`,
    );
  }
  expect(actual).toBe(RiskLevel.Low);
}

// Comprehensive list of all known `assistant` CLI subcommands.
const ASSISTANT_SUBCOMMANDS = [
  "auth",
  "avatar",
  "bash",
  "browser",
  "channel-verification-sessions",
  "completions",
  "config",
  "contacts",
  "conversations",
  "credential-execution",
  "credentials",
  "doctor",
  "email",
  "hooks",
  "keys",
  "mcp",
  "memory",
  "notifications",
  "oauth",
  "platform",
  "sequence",
  "shotgun",
  "skills",
  "trust",
  "usage",
  "autonomy",
];

describe("CLI command risk guard: assistant commands", () => {
  test("all assistant CLI subcommands classify as Low risk", async () => {
    for (const subcommand of ASSISTANT_SUBCOMMANDS) {
      const command = `assistant ${subcommand}`;
      const risk = await classifyRisk("bash", { command });
      expectLowRisk(command, risk);
    }
  });

  test("bare assistant command classifies as Low risk", async () => {
    const risk = await classifyRisk("bash", { command: "assistant" });
    expectLowRisk("assistant", risk);
  });

  test("assistant with flags classifies as Low risk", async () => {
    const flagCommands = [
      "assistant --version",
      "assistant --help",
      "assistant doctor --verbose",
    ];

    for (const command of flagCommands) {
      const risk = await classifyRisk("bash", { command });
      expectLowRisk(command, risk);
    }
  });
});
