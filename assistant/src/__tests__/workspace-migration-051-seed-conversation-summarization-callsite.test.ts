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

import { resolveCallSiteConfig } from "../config/llm-resolver.js";
import { LLMSchema } from "../config/schemas/llm.js";
import { seedConversationSummarizationCallsiteMigration } from "../workspace/migrations/051-seed-conversation-summarization-callsite.js";

let workspaceDir: string;

function freshWorkspace(): void {
  workspaceDir = join(
    tmpdir(),
    `vellum-migration-051-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

describe("051-seed-conversation-summarization-callsite migration", () => {
  test("has correct migration id", () => {
    expect(seedConversationSummarizationCallsiteMigration.id).toBe(
      "051-seed-conversation-summarization-callsite",
    );
  });

  test("seeds opus model + low effort + disabled thinking on Anthropic workspace without override", () => {
    writeConfig({
      llm: {
        default: { provider: "anthropic", model: "claude-opus-4-7" },
      },
    });

    seedConversationSummarizationCallsiteMigration.run(workspaceDir);

    const config = readConfig() as {
      llm: { callSites: Record<string, Record<string, unknown>> };
    };
    expect(config.llm.callSites.conversationSummarization).toEqual({
      model: "claude-opus-4-7",
      effort: "low",
      thinking: { enabled: false },
    });
  });

  test("fills in missing effort and thinking when only model is set (post-038 state)", () => {
    // Migration 038 may have seeded `{ model: "..." }` from legacy
    // `memory.summarization.modelIntent`. That leaves `effort` + `thinking`
    // falling through to `llm.default` — the bug this migration fixes.
    writeConfig({
      llm: {
        default: { provider: "anthropic" },
        callSites: {
          conversationSummarization: { model: "claude-opus-4-6" },
        },
      },
    });

    seedConversationSummarizationCallsiteMigration.run(workspaceDir);

    const config = readConfig() as {
      llm: { callSites: Record<string, Record<string, unknown>> };
    };
    expect(config.llm.callSites.conversationSummarization).toEqual({
      model: "claude-opus-4-6",
      effort: "low",
      thinking: { enabled: false },
    });
  });

  test("preserves user-set effort and thinking values", () => {
    writeConfig({
      llm: {
        default: { provider: "anthropic" },
        callSites: {
          conversationSummarization: {
            model: "claude-opus-4-7",
            effort: "high",
            thinking: { enabled: true },
          },
        },
      },
    });

    seedConversationSummarizationCallsiteMigration.run(workspaceDir);

    const config = readConfig() as {
      llm: { callSites: Record<string, Record<string, unknown>> };
    };
    expect(config.llm.callSites.conversationSummarization).toEqual({
      model: "claude-opus-4-7",
      effort: "high",
      thinking: { enabled: true },
    });
  });

  test("seeds openrouter-shaped model ID on openrouter workspace", () => {
    writeConfig({
      llm: {
        default: { provider: "openrouter", model: "anthropic/claude-opus-4.7" },
      },
    });

    seedConversationSummarizationCallsiteMigration.run(workspaceDir);

    const config = readConfig() as {
      llm: { callSites: Record<string, Record<string, unknown>> };
    };
    expect(config.llm.callSites.conversationSummarization).toEqual({
      model: "anthropic/claude-opus-4.7",
      effort: "low",
      thinking: { enabled: false },
    });
  });

  test("skips entirely when non-Anthropic, non-OpenRouter provider is configured", () => {
    writeConfig({
      llm: {
        default: { provider: "openai", model: "gpt-5.4" },
      },
    });

    seedConversationSummarizationCallsiteMigration.run(workspaceDir);

    const config = readConfig() as {
      llm: { callSites?: Record<string, unknown> };
    };
    expect(config.llm.callSites).toBeUndefined();
  });

  test("skips when VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH is set", () => {
    process.env.VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH = "/tmp/overlay.json";
    writeConfig({
      llm: { default: { provider: "anthropic" } },
    });

    seedConversationSummarizationCallsiteMigration.run(workspaceDir);

    const config = readConfig() as {
      llm: { callSites?: Record<string, unknown> };
    };
    expect(config.llm.callSites).toBeUndefined();
  });

  test("runs on fresh install (no config.json) and writes starter config", () => {
    expect(existsSync(configPath())).toBe(false);

    seedConversationSummarizationCallsiteMigration.run(workspaceDir);

    expect(existsSync(configPath())).toBe(true);
    const config = readConfig() as {
      llm: { callSites: Record<string, Record<string, unknown>> };
    };
    expect(config.llm.callSites.conversationSummarization).toEqual({
      model: "claude-opus-4-7",
      effort: "low",
      thinking: { enabled: false },
    });
  });

  test("is idempotent — a second run is a no-op", () => {
    writeConfig({
      llm: { default: { provider: "anthropic" } },
    });

    seedConversationSummarizationCallsiteMigration.run(workspaceDir);
    const afterFirst = readFileSync(configPath(), "utf-8");
    seedConversationSummarizationCallsiteMigration.run(workspaceDir);
    const afterSecond = readFileSync(configPath(), "utf-8");

    expect(afterSecond).toBe(afterFirst);
  });

  test("does not clobber unrelated call-site entries", () => {
    writeConfig({
      llm: {
        default: { provider: "anthropic" },
        callSites: {
          interactionClassifier: { model: "claude-haiku-4-5-20251001" },
        },
      },
    });

    seedConversationSummarizationCallsiteMigration.run(workspaceDir);

    const config = readConfig() as {
      llm: { callSites: Record<string, Record<string, unknown>> };
    };
    expect(config.llm.callSites.interactionClassifier).toEqual({
      model: "claude-haiku-4-5-20251001",
    });
    expect(config.llm.callSites.conversationSummarization).toBeDefined();
  });

  test("resolved conversationSummarization config has thinking disabled and non-max effort", () => {
    // End-to-end check: after the migration runs, parsing the seeded
    // config through `LLMSchema` and resolving the `conversationSummarization`
    // call site must produce a config that has thinking disabled and a
    // non-max effort. This is the invariant the JARVIS-587 fix depends on
    // — any regression that leaks `effort: "max"` or `thinking.enabled:
    // true` into the resolved summary config revives the 30s pipeline-
    // timeout bug.
    writeConfig({
      llm: {
        default: { provider: "anthropic", model: "claude-opus-4-7" },
      },
    });

    seedConversationSummarizationCallsiteMigration.run(workspaceDir);

    const onDisk = readConfig() as { llm: unknown };
    const parsed = LLMSchema.parse(onDisk.llm);
    const resolved = resolveCallSiteConfig("conversationSummarization", parsed);
    expect(resolved.thinking.enabled).toBe(false);
    expect(resolved.effort).not.toBe("max");
    expect(resolved.effort).toBe("low");
    expect(resolved.model).toBe("claude-opus-4-7");
  });
});
