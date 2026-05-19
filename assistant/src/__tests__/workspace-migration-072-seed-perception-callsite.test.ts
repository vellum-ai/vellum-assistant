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
import { seedPerceptionCallsiteMigration } from "../workspace/migrations/072-seed-perception-callsite.js";
import { WORKSPACE_MIGRATIONS } from "../workspace/migrations/registry.js";

let workspaceDir: string;

function freshWorkspace(): void {
  workspaceDir = join(
    tmpdir(),
    `vellum-migration-072-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

describe("072-seed-perception-callsite migration", () => {
  test("has correct migration id and is registered", () => {
    expect(seedPerceptionCallsiteMigration.id).toBe(
      "072-seed-perception-callsite",
    );
    expect(WORKSPACE_MIGRATIONS.map((m) => m.id)).toContain(
      "072-seed-perception-callsite",
    );
  });

  test("fresh config seeds explicit Anthropic cheap defaults", () => {
    expect(existsSync(configPath())).toBe(false);

    seedPerceptionCallsiteMigration.run(workspaceDir);

    expect(existsSync(configPath())).toBe(true);
    const config = readConfig() as {
      llm: { callSites: Record<string, Record<string, unknown>> };
    };
    expect(config.llm.callSites.perception).toEqual({
      provider: "anthropic",
      model: "claude-haiku-4-5-20251001",
      maxTokens: 1024,
      effort: "low",
      temperature: 0,
      thinking: { enabled: false, streamThinking: false },
      contextWindow: { maxInputTokens: 8_000 },
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

    seedPerceptionCallsiteMigration.run(workspaceDir);

    const config = readConfig() as {
      llm: { callSites: Record<string, Record<string, unknown>> };
    };
    expect(config.llm.callSites.perception).toEqual({
      profile: "cost-optimized",
      maxTokens: 1024,
      effort: "low",
      temperature: 0,
      thinking: { enabled: false, streamThinking: false },
      contextWindow: { maxInputTokens: 8_000 },
    });
  });

  test("preserves explicit user model selection unchanged", () => {
    const perception = {
      provider: "openai",
      model: "gpt-5.4-mini",
      effort: "medium",
      thinking: { enabled: true, streamThinking: true },
      contextWindow: { maxInputTokens: 32_000 },
    };
    writeConfig({
      llm: {
        default: { provider: "anthropic" },
        callSites: { perception },
      },
    });

    seedPerceptionCallsiteMigration.run(workspaceDir);

    const config = readConfig() as {
      llm: { callSites: Record<string, Record<string, unknown>> };
    };
    expect(config.llm.callSites.perception).toEqual(perception);
  });

  test("resolved perception config uses cheap bounded defaults", () => {
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

    seedPerceptionCallsiteMigration.run(workspaceDir);

    const onDisk = readConfig() as { llm: unknown };
    const parsed = LLMSchema.parse(onDisk.llm);
    const resolved = resolveCallSiteConfig("perception", parsed);
    expect(resolved.provider).toBe("anthropic");
    expect(resolved.model).toBe("claude-haiku-4-5-20251001");
    expect(resolved.maxTokens).toBe(1024);
    expect(resolved.effort).toBe("low");
    expect(resolved.temperature).toBe(0);
    expect(resolved.thinking).toEqual({
      enabled: false,
      streamThinking: false,
    });
    expect(resolved.contextWindow.maxInputTokens).toBe(8_000);
  });
});
