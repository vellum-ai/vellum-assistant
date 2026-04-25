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
import { seedRecallCallsiteMigration } from "../workspace/migrations/054-seed-recall-callsite.js";

let workspaceDir: string;

function freshWorkspace(): void {
  workspaceDir = join(
    tmpdir(),
    `vellum-migration-054-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

describe("054-seed-recall-callsite migration", () => {
  test("has correct migration id", () => {
    expect(seedRecallCallsiteMigration.id).toBe("054-seed-recall-callsite");
  });

  test("LLMSchema accepts the recall call site", () => {
    const parsed = LLMSchema.parse({
      callSites: {
        recall: {
          profile: "cost-optimized",
          maxTokens: 4096,
          effort: "low",
          thinking: { enabled: false, streamThinking: false },
          temperature: 0,
        },
      },
      profiles: {
        "cost-optimized": {
          provider: "anthropic",
          model: "claude-haiku-4-5-20251001",
        },
      },
    });

    expect(parsed.callSites.recall).toEqual({
      profile: "cost-optimized",
      maxTokens: 4096,
      effort: "low",
      thinking: { enabled: false, streamThinking: false },
      temperature: 0,
    });
  });

  test("fresh config seeds Anthropic cheap defaults when cost profile is absent", () => {
    expect(existsSync(configPath())).toBe(false);

    seedRecallCallsiteMigration.run(workspaceDir);

    expect(existsSync(configPath())).toBe(true);
    const config = readConfig() as {
      llm: { callSites: Record<string, Record<string, unknown>> };
    };
    expect(config.llm.callSites.recall).toEqual({
      model: "claude-haiku-4-5-20251001",
      maxTokens: 4096,
      effort: "low",
      thinking: { enabled: false, streamThinking: false },
      temperature: 0,
    });
  });

  test("existing config uses cost-optimized profile when it exists", () => {
    writeConfig({
      llm: {
        default: { provider: "anthropic", model: "claude-opus-4-7" },
        profiles: {
          "cost-optimized": {
            provider: "anthropic",
            model: "claude-haiku-4-5-20251001",
            maxTokens: 8192,
          },
        },
      },
    });

    seedRecallCallsiteMigration.run(workspaceDir);

    const config = readConfig() as {
      llm: { callSites: Record<string, Record<string, unknown>> };
    };
    expect(config.llm.callSites.recall).toEqual({
      profile: "cost-optimized",
      maxTokens: 4096,
      effort: "low",
      thinking: { enabled: false, streamThinking: false },
      temperature: 0,
    });
  });

  test("preserves user-defined recall call site unchanged", () => {
    const userRecall = {
      provider: "openai",
      model: "gpt-5.4",
      maxTokens: 2048,
      effort: "medium",
      thinking: { enabled: true, streamThinking: true },
      temperature: 0.7,
    };
    writeConfig({
      llm: {
        default: { provider: "anthropic" },
        profiles: {
          "cost-optimized": {
            provider: "anthropic",
            model: "claude-haiku-4-5-20251001",
          },
        },
        callSites: {
          recall: userRecall,
        },
      },
    });

    seedRecallCallsiteMigration.run(workspaceDir);

    const config = readConfig() as {
      llm: { callSites: Record<string, Record<string, unknown>> };
    };
    expect(config.llm.callSites.recall).toEqual(userRecall);
  });

  test("missing cost profile falls back to provider-specific cheap defaults", () => {
    writeConfig({
      llm: {
        default: { provider: "openai", model: "gpt-5.4" },
        profiles: {
          balanced: {
            provider: "openai",
            model: "gpt-5.4",
          },
        },
      },
    });

    seedRecallCallsiteMigration.run(workspaceDir);

    const config = readConfig() as {
      llm: { callSites: Record<string, Record<string, unknown>> };
    };
    expect(config.llm.callSites.recall).toEqual({
      model: "gpt-5.4-nano",
      maxTokens: 4096,
      effort: "low",
      thinking: { enabled: false, streamThinking: false },
      temperature: 0,
    });
  });

  test("skips when VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH is set", () => {
    process.env.VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH = "/tmp/overlay.json";
    writeConfig({
      llm: { default: { provider: "anthropic" } },
    });

    seedRecallCallsiteMigration.run(workspaceDir);

    const config = readConfig() as {
      llm: { callSites?: Record<string, unknown> };
    };
    expect(config.llm.callSites).toBeUndefined();
  });

  test("resolved recall config uses cost profile model with low-cost leaves", () => {
    writeConfig({
      llm: {
        default: { provider: "anthropic", model: "claude-opus-4-7" },
        profiles: {
          "cost-optimized": {
            provider: "anthropic",
            model: "claude-haiku-4-5-20251001",
            maxTokens: 8192,
            effort: "low",
            thinking: { enabled: false, streamThinking: false },
          },
        },
      },
    });

    seedRecallCallsiteMigration.run(workspaceDir);

    const onDisk = readConfig() as { llm: unknown };
    const parsed = LLMSchema.parse(onDisk.llm);
    const resolved = resolveCallSiteConfig("recall", parsed);
    expect(resolved.model).toBe("claude-haiku-4-5-20251001");
    expect(resolved.maxTokens).toBe(4096);
    expect(resolved.effort).toBe("low");
    expect(resolved.thinking).toEqual({
      enabled: false,
      streamThinking: false,
    });
    expect(resolved.temperature).toBe(0);
  });
});
