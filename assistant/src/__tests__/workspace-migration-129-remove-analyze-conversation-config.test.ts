import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { removeAnalyzeConversationConfigMigration } from "../workspace/migrations/129-remove-analyze-conversation-config.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let workspaceDir: string;

function freshWorkspace(): void {
  workspaceDir = join(
    tmpdir(),
    `vellum-migration-129-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(workspaceDir, { recursive: true });
}

function writeConfig(data: Record<string, unknown>): void {
  writeFileSync(
    join(workspaceDir, "config.json"),
    JSON.stringify(data, null, 2) + "\n",
  );
}

function readConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(workspaceDir, "config.json"), "utf-8"));
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  freshWorkspace();
});

afterEach(() => {
  if (existsSync(workspaceDir)) {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("129-remove-analyze-conversation-config migration", () => {
  test("has correct migration id", () => {
    expect(removeAnalyzeConversationConfigMigration.id).toBe(
      "129-remove-analyze-conversation-config",
    );
  });

  // ─── No-op cases ────────────────────────────────────────────────────────

  test("no-op when config.json does not exist", () => {
    removeAnalyzeConversationConfigMigration.run(workspaceDir);
    expect(existsSync(join(workspaceDir, "config.json"))).toBe(false);
  });

  test("gracefully handles invalid JSON in config file", () => {
    writeFileSync(join(workspaceDir, "config.json"), "not-valid-json");
    removeAnalyzeConversationConfigMigration.run(workspaceDir);
    expect(readFileSync(join(workspaceDir, "config.json"), "utf-8")).toBe(
      "not-valid-json",
    );
  });

  test("no-op when config has neither targeted key", () => {
    const original = {
      llm: {
        default: { provider: "anthropic", model: "claude-opus-4-8" },
        callSites: { mainAgent: { profile: "balanced" } },
      },
      otherSetting: true,
    };
    writeConfig(original);

    removeAnalyzeConversationConfigMigration.run(workspaceDir);

    expect(readConfig()).toEqual(original);
  });

  // ─── Removal ────────────────────────────────────────────────────────────

  test("removes llm.callSites.analyzeConversation and preserves siblings", () => {
    writeConfig({
      llm: {
        default: { provider: "anthropic", model: "claude-opus-4-8" },
        callSites: {
          analyzeConversation: { model: "claude-opus-4-7", effort: "low" },
          mainAgent: { profile: "balanced" },
        },
      },
    });

    removeAnalyzeConversationConfigMigration.run(workspaceDir);

    const config = readConfig();
    const llm = config.llm as { callSites: Record<string, unknown> };
    expect(llm.callSites.analyzeConversation).toBeUndefined();
    expect(llm.callSites.mainAgent).toEqual({ profile: "balanced" });
  });

  test("removes the top-level analysis block", () => {
    writeConfig({
      analysis: { batchSize: 30, idleTimeoutMs: 600000 },
      otherSetting: "preserved",
    });

    removeAnalyzeConversationConfigMigration.run(workspaceDir);

    const config = readConfig();
    expect(config.analysis).toBeUndefined();
    expect(config.otherSetting).toBe("preserved");
  });

  test("removes both keys when both are present", () => {
    writeConfig({
      analysis: { batchSize: 10 },
      llm: {
        callSites: {
          analyzeConversation: { profile: "balanced" },
          recall: { effort: "low" },
        },
      },
    });

    removeAnalyzeConversationConfigMigration.run(workspaceDir);

    const config = readConfig();
    expect(config.analysis).toBeUndefined();
    const llm = config.llm as { callSites: Record<string, unknown> };
    expect(llm.callSites.analyzeConversation).toBeUndefined();
    expect(llm.callSites.recall).toEqual({ effort: "low" });
  });

  // ─── Idempotency ───────────────────────────────────────────────────────

  test("idempotency: re-running the migration yields no further mutation", () => {
    writeConfig({
      analysis: { batchSize: 30 },
      llm: { callSites: { analyzeConversation: { effort: "low" } } },
    });

    removeAnalyzeConversationConfigMigration.run(workspaceDir);
    const afterFirst = readConfig();

    removeAnalyzeConversationConfigMigration.run(workspaceDir);
    const afterSecond = readConfig();

    expect(afterSecond).toEqual(afterFirst);
  });

  // ─── Defensive shape handling ──────────────────────────────────────────

  test("ignores non-object values at sub-paths", () => {
    writeConfig({
      llm: "not-an-object",
      analysis: { batchSize: 30 },
    });

    removeAnalyzeConversationConfigMigration.run(workspaceDir);

    const config = readConfig();
    expect(config.analysis).toBeUndefined();
    expect(config.llm).toBe("not-an-object");
  });

  test("ignores non-object callSites", () => {
    const original = {
      llm: { callSites: ["not", "an", "object"] },
    };
    writeConfig(original);

    removeAnalyzeConversationConfigMigration.run(workspaceDir);

    expect(readConfig()).toEqual(original);
  });
});
