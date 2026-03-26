// Guard test: assistant CLI commands must classify at the expected risk level.
//
// The assistant uses its own CLI tools during normal operation. Most commands
// should be Low risk so they don't block autonomous workflows. Certain
// sensitive subcommands are intentionally elevated to Medium or High.
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

import { buildCliProgram } from "../cli/program.js";
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
        `assistant CLI commands must be Low risk by default — the assistant ` +
        `uses its own CLI during normal operation. If you need risk ` +
        `escalation for specific subcommands, add them to the elevated ` +
        `risk tests in this guard test with justification.`,
    );
  }
  expect(actual).toBe(RiskLevel.Low);
}

// Dynamically extract subcommand names from the CLI program definition.
// This ensures new commands added to program.ts are automatically covered
// by this guard test without manual list maintenance.
const program = buildCliProgram();
const ASSISTANT_SUBCOMMANDS = program.commands.map((c) => c.name());

describe("CLI command risk guard: assistant commands", () => {
  test("subcommand discovery found a reasonable number of commands", () => {
    // Sanity check: if mocking breaks and no commands are registered,
    // the risk guard would vacuously pass. Require a minimum count to
    // catch that failure mode. Update this threshold when commands are
    // removed (but it should only grow).
    expect(ASSISTANT_SUBCOMMANDS.length).toBeGreaterThanOrEqual(20);
  });

  test("all assistant CLI subcommands classify as Low risk", async () => {
    for (const subcommand of ASSISTANT_SUBCOMMANDS) {
      // Subcommands with elevated children are tested separately below.
      // The bare top-level subcommand (e.g. `assistant oauth`) is still
      // expected to be Low.
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

// Sensitive subcommands that are intentionally elevated above Low risk.
// Each entry documents why the elevation is necessary.

describe("CLI command risk guard: elevated assistant subcommands", () => {
  test("assistant oauth token is High risk (exposes raw tokens)", async () => {
    const risk = await classifyRisk("bash", {
      command: "assistant oauth token",
    });
    expect(risk).toBe(RiskLevel.High);
  });

  test("assistant oauth mode --set is High risk (changes auth mode)", async () => {
    const risk = await classifyRisk("bash", {
      command: "assistant oauth mode --set managed",
    });
    expect(risk).toBe(RiskLevel.High);
  });

  test("assistant oauth mode --set=value is High risk (equals syntax)", async () => {
    const risk = await classifyRisk("bash", {
      command: "assistant oauth mode google --set=managed",
    });
    expect(risk).toBe(RiskLevel.High);
  });

  test("assistant oauth mode without --set is Low risk (read-only)", async () => {
    const risk = await classifyRisk("bash", {
      command: "assistant oauth mode",
    });
    expect(risk).toBe(RiskLevel.Low);
  });

  test("assistant credentials reveal is High risk (exposes secrets)", async () => {
    const risk = await classifyRisk("bash", {
      command: "assistant credentials reveal",
    });
    expect(risk).toBe(RiskLevel.High);
  });

  test("assistant oauth request is Medium risk (initiates OAuth flow)", async () => {
    const risk = await classifyRisk("bash", {
      command: "assistant oauth request",
    });
    expect(risk).toBe(RiskLevel.Medium);
  });

  test("assistant oauth connect is Medium risk (modifies OAuth connections)", async () => {
    const risk = await classifyRisk("bash", {
      command: "assistant oauth connect",
    });
    expect(risk).toBe(RiskLevel.Medium);
  });

  test("assistant oauth disconnect is Medium risk (removes OAuth connections)", async () => {
    const risk = await classifyRisk("bash", {
      command: "assistant oauth disconnect",
    });
    expect(risk).toBe(RiskLevel.Medium);
  });

  test("--help on elevated subcommands is Low risk (read-only)", async () => {
    const helpCommands = [
      "assistant oauth token --help",
      "assistant oauth mode --set --help",
      "assistant credentials reveal --help",
      "assistant oauth request --help",
      "assistant oauth connect --help",
      "assistant oauth disconnect -h",
    ];

    for (const command of helpCommands) {
      const risk = await classifyRisk("bash", { command });
      expectLowRisk(command, risk);
    }
  });

  test("non-sensitive oauth subcommands remain Low risk", async () => {
    const lowRiskOauthCommands = [
      "assistant oauth apps",
      "assistant oauth apps list",
      "assistant oauth providers",
      "assistant oauth status",
    ];

    for (const command of lowRiskOauthCommands) {
      const risk = await classifyRisk("bash", { command });
      expectLowRisk(command, risk);
    }
  });

  test("non-sensitive credentials subcommands remain Low risk", async () => {
    const lowRiskCredCommands = [
      "assistant credentials",
      "assistant credentials list",
    ];

    for (const command of lowRiskCredCommands) {
      const risk = await classifyRisk("bash", { command });
      expectLowRisk(command, risk);
    }
  });
});

describe("CLI command risk guard: wrapper program propagation", () => {
  test("env assistant oauth token is High risk", async () => {
    const risk = await classifyRisk("bash", {
      command: "env assistant oauth token",
    });
    expect(risk).toBe(RiskLevel.High);
  });

  test("nice assistant credentials reveal is High risk", async () => {
    const risk = await classifyRisk("bash", {
      command: "nice assistant credentials reveal",
    });
    expect(risk).toBe(RiskLevel.High);
  });

  test("timeout 30 assistant oauth request is Medium risk", async () => {
    const risk = await classifyRisk("bash", {
      command: "timeout 30 assistant oauth request",
    });
    expect(risk).toBe(RiskLevel.Medium);
  });

  test("timeout 30 assistant oauth token is High risk", async () => {
    const risk = await classifyRisk("bash", {
      command: "timeout 30 assistant oauth token",
    });
    expect(risk).toBe(RiskLevel.High);
  });

  test("timeout 30 git push is Medium risk", async () => {
    const risk = await classifyRisk("bash", {
      command: "timeout 30 git push",
    });
    expect(risk).toBe(RiskLevel.Medium);
  });

  test("timeout 30 git status is Low risk", async () => {
    const risk = await classifyRisk("bash", {
      command: "timeout 30 git status",
    });
    expectLowRisk("timeout 30 git status", risk);
  });

  test("env assistant config is Low risk", async () => {
    const risk = await classifyRisk("bash", {
      command: "env assistant config",
    });
    expectLowRisk("env assistant config", risk);
  });

  test("env git push is Medium risk (not Low)", async () => {
    const risk = await classifyRisk("bash", { command: "env git push" });
    expect(risk).toBe(RiskLevel.Medium);
  });

  test("env git status is Low risk", async () => {
    const risk = await classifyRisk("bash", { command: "env git status" });
    expectLowRisk("env git status", risk);
  });
});
