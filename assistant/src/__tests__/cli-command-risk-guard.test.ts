// Guard test: assistant CLI commands must classify at the expected risk level.
//
// The assistant uses its own CLI tools during normal operation. Most commands
// should be Low risk so they don't block autonomous workflows. Certain
// sensitive subcommands are intentionally elevated to Medium or High.
// See #18982 / #18998 for the regression that motivated this guard.

import { describe, expect, mock, test } from "bun:test";

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

import { createGatewayClientMock } from "./helpers/gateway-classify-mock.js";
mock.module("../ipc/gateway-client.js", () => createGatewayClientMock());

import { buildCliProgram } from "../cli/program.js";
import type { RiskClassification } from "../permissions/checker.js";
import { classifyRisk } from "../permissions/checker.js";
import { RiskLevel } from "../permissions/types.js";

/**
 * Assert that a command classifies as Low risk, with a descriptive failure
 * message that guides developers toward the correct fix.
 */
function expectLowRisk(command: string, actual: RiskClassification): void {
  if (actual.level !== RiskLevel.Low) {
    throw new Error(
      `"${command}" classified as ${actual.level} instead of Low. ` +
        `assistant CLI commands must be Low risk by default — the assistant ` +
        `uses its own CLI during normal operation. If you need risk ` +
        `escalation for specific subcommands, add them to the elevated ` +
        `risk tests in this guard test with justification.`,
    );
  }
  expect(actual.level).toBe(RiskLevel.Low);
}

// Dynamically extract subcommand names from the CLI program definition.
// This ensures new commands added to program.ts are automatically covered
// by this guard test without manual list maintenance.
const program = await buildCliProgram();
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
    const flagCommands = ["assistant --version", "assistant --help"];

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
    expect(risk.level).toBe(RiskLevel.High);
  });

  test("assistant oauth mode --set is High risk (changes auth mode)", async () => {
    const risk = await classifyRisk("bash", {
      command: "assistant oauth mode --set managed",
    });
    expect(risk.level).toBe(RiskLevel.High);
  });

  test("assistant oauth mode --set=value is High risk (equals syntax)", async () => {
    const risk = await classifyRisk("bash", {
      command: "assistant oauth mode google --set=managed",
    });
    expect(risk.level).toBe(RiskLevel.High);
  });

  test("assistant oauth mode without --set is Low risk (read-only)", async () => {
    const risk = await classifyRisk("bash", {
      command: "assistant oauth mode",
    });
    expect(risk.level).toBe(RiskLevel.Low);
  });

  test("assistant credentials reveal is High risk (exposes secrets)", async () => {
    const risk = await classifyRisk("bash", {
      command: "assistant credentials reveal",
    });
    expect(risk.level).toBe(RiskLevel.High);
  });

  test("assistant oauth request is Medium risk (initiates OAuth flow)", async () => {
    const risk = await classifyRisk("bash", {
      command: "assistant oauth request",
    });
    expect(risk.level).toBe(RiskLevel.Medium);
  });

  test("assistant oauth connect is Low risk (initiates OAuth flow)", async () => {
    const risk = await classifyRisk("bash", {
      command: "assistant oauth connect",
    });
    expect(risk.level).toBe(RiskLevel.Low);
  });

  test("assistant oauth disconnect is Medium risk (removes OAuth connections)", async () => {
    const risk = await classifyRisk("bash", {
      command: "assistant oauth disconnect",
    });
    expect(risk.level).toBe(RiskLevel.Medium);
  });

  test("--help on non-elevated subcommands remains Low risk", async () => {
    // GIVEN non-elevated subcommands with --help / -h flags
    const lowRiskWithHelp = [
      "assistant oauth --help",
      "assistant credentials --help",
      "assistant trust -h",
      "assistant keys --help",
      "assistant config --help",
    ];

    // WHEN classifying risk
    // THEN they remain Low since the subcommand itself is Low
    for (const command of lowRiskWithHelp) {
      const risk = await classifyRisk("bash", { command });
      expectLowRisk(command, risk);
    }
  });

  test("--help does not downgrade risk on elevated subcommands", async () => {
    // GIVEN elevated subcommands with --help / -h flags appended
    const highRiskWithHelp = [
      "assistant oauth token --help",
      "assistant oauth mode --set --help",
      "assistant credentials reveal --help",
      "assistant trust clear --help",
      "assistant trust remove -h",
      "assistant credentials set --help",
      "assistant credentials delete -h",
      "assistant keys set --help",
      "assistant keys delete -h",
    ];

    const mediumRiskWithHelp = [
      "assistant oauth request --help",
      "assistant oauth disconnect -h",
    ];

    // WHEN classifying risk
    // THEN --help does not bypass the elevated risk level
    for (const command of highRiskWithHelp) {
      const risk = await classifyRisk("bash", { command });
      expect(risk.level).toBe(RiskLevel.High);
    }

    for (const command of mediumRiskWithHelp) {
      const risk = await classifyRisk("bash", { command });
      expect(risk.level).toBe(RiskLevel.Medium);
    }
  });

  test("--help used as option value does not downgrade credentials reveal risk", async () => {
    const risk = await classifyRisk("bash", {
      command: "assistant credentials reveal 123 --service --help",
    });
    expect(risk.level).toBe(RiskLevel.High);
  });

  test("-h used as option value does not downgrade oauth mode --set risk", async () => {
    const risk = await classifyRisk("bash", {
      command: "assistant oauth mode --set -h",
    });
    expect(risk.level).toBe(RiskLevel.High);
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

  test("assistant credentials set is High risk (modifies stored credentials)", async () => {
    const risk = await classifyRisk("bash", {
      command: "assistant credentials set",
    });
    expect(risk.level).toBe(RiskLevel.High);
  });

  test("assistant credentials delete is High risk (removes stored credentials)", async () => {
    const risk = await classifyRisk("bash", {
      command: "assistant credentials delete",
    });
    expect(risk.level).toBe(RiskLevel.High);
  });

  test("assistant keys set is High risk (modifies API keys)", async () => {
    const risk = await classifyRisk("bash", {
      command: "assistant keys set anthropic sk-ant-xxx",
    });
    expect(risk.level).toBe(RiskLevel.High);
  });

  test("assistant keys delete is High risk (removes API keys)", async () => {
    const risk = await classifyRisk("bash", {
      command: "assistant keys delete openai",
    });
    expect(risk.level).toBe(RiskLevel.High);
  });

  test("non-sensitive keys subcommands remain Low risk", async () => {
    const lowRiskKeysCommands = ["assistant keys", "assistant keys list"];

    for (const command of lowRiskKeysCommands) {
      const risk = await classifyRisk("bash", { command });
      expectLowRisk(command, risk);
    }
  });

  test("assistant trust remove is High risk (removes trust rules)", async () => {
    const risk = await classifyRisk("bash", {
      command: "assistant trust remove abc123",
    });
    expect(risk.level).toBe(RiskLevel.High);
  });

  test("assistant trust clear is High risk (clears all trust rules)", async () => {
    const risk = await classifyRisk("bash", {
      command: "assistant trust clear",
    });
    expect(risk.level).toBe(RiskLevel.High);
  });

  test("non-sensitive trust subcommands remain Low risk", async () => {
    const lowRiskTrustCommands = ["assistant trust", "assistant trust list"];

    for (const command of lowRiskTrustCommands) {
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
    expect(risk.level).toBe(RiskLevel.High);
  });

  test("nice assistant credentials reveal is High risk", async () => {
    const risk = await classifyRisk("bash", {
      command: "nice assistant credentials reveal",
    });
    expect(risk.level).toBe(RiskLevel.High);
  });

  test("timeout 30 assistant oauth request is Medium risk", async () => {
    const risk = await classifyRisk("bash", {
      command: "timeout 30 assistant oauth request",
    });
    expect(risk.level).toBe(RiskLevel.Medium);
  });

  test("timeout 30 assistant oauth token is High risk", async () => {
    const risk = await classifyRisk("bash", {
      command: "timeout 30 assistant oauth token",
    });
    expect(risk.level).toBe(RiskLevel.High);
  });

  test("timeout 30 git push is Medium risk", async () => {
    const risk = await classifyRisk("bash", {
      command: "timeout 30 git push",
    });
    expect(risk.level).toBe(RiskLevel.Medium);
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
    expect(risk.level).toBe(RiskLevel.Medium);
  });

  test("env git status is Low risk", async () => {
    const risk = await classifyRisk("bash", { command: "env git status" });
    expectLowRisk("env git status", risk);
  });
});
