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
import { seedHeartbeatCallsiteCostDefaultMigration } from "../workspace/migrations/066-seed-heartbeat-callsite-cost-default.js";
import { WORKSPACE_MIGRATIONS } from "../workspace/migrations/registry.js";

let workspaceDir: string;

function freshWorkspace(): void {
  workspaceDir = join(
    tmpdir(),
    `vellum-migration-066-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(workspaceDir, { recursive: true });
}

function configPath(): string {
  return join(workspaceDir, "config.json");
}

function writeConfig(data: Record<string, unknown>): void {
  writeFileSync(configPath(), JSON.stringify(data, null, 2) + "\n");
}

function readConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(configPath(), "utf-8"));
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

describe("066-seed-heartbeat-callsite-cost-default migration", () => {
  test("has correct migration id and is registered", () => {
    expect(seedHeartbeatCallsiteCostDefaultMigration.id).toBe(
      "066-seed-heartbeat-callsite-cost-default",
    );
    expect(WORKSPACE_MIGRATIONS.map((m) => m.id)).toContain(
      "066-seed-heartbeat-callsite-cost-default",
    );
  });

  test("fresh config seeds explicit Anthropic cheap defaults", () => {
    expect(existsSync(configPath())).toBe(false);

    seedHeartbeatCallsiteCostDefaultMigration.run(workspaceDir);

    expect(existsSync(configPath())).toBe(true);
    const config = readConfig() as {
      llm: { callSites: Record<string, Record<string, unknown>> };
    };
    expect(config.llm.callSites.heartbeatAgent).toEqual({
      provider: "anthropic",
      model: "claude-haiku-4-5-20251001",
      maxTokens: 2048,
      effort: "low",
      temperature: 0,
      thinking: { enabled: false, streamThinking: false },
      contextWindow: { maxInputTokens: 16_000 },
    });
  });

  test("uses matching cost-optimized profile when present", () => {
    writeConfig({
      llm: {
        default: { provider: "anthropic", model: "claude-sonnet-4-6" },
        profiles: {
          "cost-optimized": {
            provider: "anthropic",
            model: "claude-haiku-4-5-20251001",
          },
        },
      },
    });

    seedHeartbeatCallsiteCostDefaultMigration.run(workspaceDir);

    const config = readConfig() as {
      llm: { callSites: Record<string, Record<string, unknown>> };
    };
    expect(config.llm.callSites.heartbeatAgent).toEqual({
      profile: "cost-optimized",
      maxTokens: 2048,
      effort: "low",
      temperature: 0,
      thinking: { enabled: false, streamThinking: false },
      contextWindow: { maxInputTokens: 16_000 },
    });
  });

  test("fills missing leaves on legacy heartbeat speed override", () => {
    writeConfig({
      llm: {
        default: { provider: "anthropic" },
        callSites: {
          heartbeatAgent: { speed: "fast" },
        },
      },
    });

    seedHeartbeatCallsiteCostDefaultMigration.run(workspaceDir);

    const config = readConfig() as {
      llm: { callSites: Record<string, Record<string, unknown>> };
    };
    expect(config.llm.callSites.heartbeatAgent).toEqual({
      speed: "fast",
      provider: "anthropic",
      model: "claude-haiku-4-5-20251001",
      maxTokens: 2048,
      effort: "low",
      temperature: 0,
      thinking: { enabled: false, streamThinking: false },
      contextWindow: { maxInputTokens: 16_000 },
    });
  });

  test("preserves explicit user model selection unchanged", () => {
    const heartbeatAgent = {
      provider: "openai",
      model: "gpt-5.4-mini",
      effort: "medium",
      thinking: { enabled: true },
      contextWindow: { enabled: false },
    };
    writeConfig({
      llm: {
        default: { provider: "anthropic" },
        callSites: {
          heartbeatAgent,
        },
      },
    });

    seedHeartbeatCallsiteCostDefaultMigration.run(workspaceDir);

    const config = readConfig() as {
      llm: { callSites: Record<string, Record<string, unknown>> };
    };
    expect(config.llm.callSites.heartbeatAgent).toEqual(heartbeatAgent);
  });

  test("preserves explicit user profile selection unchanged", () => {
    const heartbeatAgent = {
      profile: "quality-optimized",
    };
    writeConfig({
      llm: {
        default: { provider: "anthropic" },
        profiles: {
          "quality-optimized": {
            provider: "anthropic",
            model: "claude-opus-4-7",
            effort: "max",
            thinking: { enabled: true, streamThinking: true },
          },
        },
        callSites: {
          heartbeatAgent,
        },
      },
    });

    seedHeartbeatCallsiteCostDefaultMigration.run(workspaceDir);

    const config = readConfig() as {
      llm: { callSites: Record<string, Record<string, unknown>> };
    };
    expect(config.llm.callSites.heartbeatAgent).toEqual(heartbeatAgent);
  });

  test("seeds provider-specific cheap model for OpenAI workspaces", () => {
    writeConfig({
      llm: {
        default: { provider: "openai", model: "gpt-5.4" },
        profiles: {
          "cost-optimized": {
            provider: "anthropic",
            model: "claude-haiku-4-5-20251001",
          },
        },
      },
    });

    seedHeartbeatCallsiteCostDefaultMigration.run(workspaceDir);

    const config = readConfig() as {
      llm: { callSites: Record<string, Record<string, unknown>> };
    };
    expect(config.llm.callSites.heartbeatAgent).toEqual({
      provider: "openai",
      model: "gpt-5.4-nano",
      maxTokens: 2048,
      effort: "low",
      temperature: 0,
      thinking: { enabled: false, streamThinking: false },
      contextWindow: { maxInputTokens: 16_000 },
    });
  });

  test("seeds existing Gemini latency model for Gemini workspaces", () => {
    writeConfig({
      llm: {
        default: { provider: "gemini", model: "gemini-3.1-pro-preview" },
      },
    });

    seedHeartbeatCallsiteCostDefaultMigration.run(workspaceDir);

    const config = readConfig() as {
      llm: { callSites: Record<string, Record<string, unknown>> };
    };
    expect(config.llm.callSites.heartbeatAgent).toEqual({
      provider: "gemini",
      model: "gemini-3-flash",
      maxTokens: 2048,
      effort: "low",
      temperature: 0,
      thinking: { enabled: false, streamThinking: false },
      contextWindow: { maxInputTokens: 16_000 },
    });
  });

  test("skips when VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH is set", () => {
    process.env.VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH = "/tmp/overlay.json";
    writeConfig({
      llm: { default: { provider: "anthropic" } },
    });

    seedHeartbeatCallsiteCostDefaultMigration.run(workspaceDir);

    const config = readConfig() as {
      llm: { callSites?: Record<string, unknown> };
    };
    expect(config.llm.callSites).toBeUndefined();
  });

  test("resolved heartbeat config uses cheap model and bounded context", () => {
    writeConfig({
      llm: {
        default: {
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          effort: "high",
          thinking: { enabled: true, streamThinking: true },
          contextWindow: { maxInputTokens: 200_000 },
        },
      },
    });

    seedHeartbeatCallsiteCostDefaultMigration.run(workspaceDir);

    const onDisk = readConfig() as { llm: unknown };
    const parsed = LLMSchema.parse(onDisk.llm);
    const resolved = resolveCallSiteConfig("heartbeatAgent", parsed);
    expect(resolved.provider).toBe("anthropic");
    expect(resolved.model).toBe("claude-haiku-4-5-20251001");
    expect(resolved.maxTokens).toBe(2048);
    expect(resolved.effort).toBe("low");
    expect(resolved.temperature).toBe(0);
    expect(resolved.thinking).toEqual({
      enabled: false,
      streamThinking: false,
    });
    expect(resolved.contextWindow.maxInputTokens).toBe(16_000);
  });
});
