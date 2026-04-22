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

import { seedConversationStartersCallsiteMigration } from "../workspace/migrations/046-seed-conversation-starters-callsite.js";

let workspaceDir: string;

function freshWorkspace(): void {
  workspaceDir = join(
    tmpdir(),
    `vellum-migration-046-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

function configPath(): string {
  return join(workspaceDir, "config.json");
}

beforeEach(() => {
  freshWorkspace();
  delete process.env.VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH;
});

afterEach(() => {
  delete process.env.VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH;
  if (existsSync(workspaceDir)) {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

describe("046-seed-conversation-starters-callsite migration", () => {
  test("has correct migration id", () => {
    expect(seedConversationStartersCallsiteMigration.id).toBe(
      "046-seed-conversation-starters-callsite",
    );
  });

  test("seeds haiku callsite entry on Anthropic workspace without override", () => {
    writeConfig({
      llm: {
        default: { provider: "anthropic", model: "claude-opus-4-7" },
        callSites: {
          interactionClassifier: { model: "claude-haiku-4-5-20251001" },
        },
      },
    });

    seedConversationStartersCallsiteMigration.run(workspaceDir);

    const config = readConfig() as {
      llm: { callSites: Record<string, Record<string, unknown>> };
    };
    expect(config.llm.callSites.conversationStarters).toEqual({
      model: "claude-haiku-4-5-20251001",
      effort: "low",
      thinking: { enabled: false },
    });
    // Does not clobber unrelated entries.
    expect(config.llm.callSites.interactionClassifier).toEqual({
      model: "claude-haiku-4-5-20251001",
    });
  });

  test("seeds openrouter-shaped model ID on openrouter workspace", () => {
    writeConfig({
      llm: {
        default: { provider: "openrouter", model: "anthropic/claude-opus-4.7" },
      },
    });

    seedConversationStartersCallsiteMigration.run(workspaceDir);

    const config = readConfig() as {
      llm: { callSites: Record<string, Record<string, unknown>> };
    };
    expect(config.llm.callSites.conversationStarters).toEqual({
      model: "anthropic/claude-haiku-4.5",
      effort: "low",
      thinking: { enabled: false },
    });
  });

  test("skips when conversationStarters already has an explicit override", () => {
    writeConfig({
      llm: {
        default: { provider: "anthropic" },
        callSites: {
          conversationStarters: {
            model: "claude-opus-4-7",
            effort: "high",
          },
        },
      },
    });

    seedConversationStartersCallsiteMigration.run(workspaceDir);

    const config = readConfig() as {
      llm: { callSites: Record<string, Record<string, unknown>> };
    };
    expect(config.llm.callSites.conversationStarters).toEqual({
      model: "claude-opus-4-7",
      effort: "high",
    });
  });

  test("skips entirely when non-Anthropic, non-OpenRouter provider is configured", () => {
    writeConfig({
      llm: {
        default: { provider: "openai", model: "gpt-5.4" },
      },
    });

    seedConversationStartersCallsiteMigration.run(workspaceDir);

    const config = readConfig() as {
      llm: { callSites?: Record<string, unknown> };
    };
    // No callSites object created at all.
    expect(config.llm.callSites).toBeUndefined();
  });

  test("skips when VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH is set", () => {
    process.env.VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH = "/tmp/overlay.json";
    writeConfig({
      llm: { default: { provider: "anthropic" } },
    });

    seedConversationStartersCallsiteMigration.run(workspaceDir);

    const config = readConfig() as {
      llm: { callSites?: Record<string, unknown> };
    };
    expect(config.llm.callSites).toBeUndefined();
  });

  test("runs on fresh install (no config.json) and writes starter config", () => {
    expect(existsSync(configPath())).toBe(false);

    seedConversationStartersCallsiteMigration.run(workspaceDir);

    expect(existsSync(configPath())).toBe(true);
    const config = readConfig() as {
      llm: { callSites: Record<string, Record<string, unknown>> };
    };
    expect(config.llm.callSites.conversationStarters).toEqual({
      model: "claude-haiku-4-5-20251001",
      effort: "low",
      thinking: { enabled: false },
    });
  });

  test("is idempotent — a second run is a no-op", () => {
    writeConfig({
      llm: { default: { provider: "anthropic" } },
    });

    seedConversationStartersCallsiteMigration.run(workspaceDir);
    const afterFirst = readFileSync(configPath(), "utf-8");
    seedConversationStartersCallsiteMigration.run(workspaceDir);
    const afterSecond = readFileSync(configPath(), "utf-8");

    expect(afterSecond).toBe(afterFirst);
  });
});
