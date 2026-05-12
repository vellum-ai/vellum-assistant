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

import { seedMemoryRouterCallsiteMigration } from "../workspace/migrations/077-seed-memory-router-callsite.js";

let workspaceDir: string;

function freshWorkspace(): void {
  workspaceDir = join(
    tmpdir(),
    `vellum-migration-076-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

describe("077-seed-memory-router-callsite migration", () => {
  test("has correct migration id", () => {
    expect(seedMemoryRouterCallsiteMigration.id).toBe(
      "077-seed-memory-router-callsite",
    );
  });

  test("seeds memoryRouter with Sonnet 4.6 + 1M context on Anthropic workspace", () => {
    writeConfig({
      llm: { default: { provider: "anthropic" } },
    });

    seedMemoryRouterCallsiteMigration.run(workspaceDir);

    const config = readConfig() as {
      llm: { callSites: Record<string, Record<string, unknown>> };
    };
    expect(config.llm.callSites.memoryRouter).toEqual({
      model: "claude-sonnet-4-6",
      contextWindow: { maxInputTokens: 1_000_000 },
    });
  });

  test("writes fresh starter config when config.json is absent", () => {
    seedMemoryRouterCallsiteMigration.run(workspaceDir);

    expect(existsSync(configPath())).toBe(true);
    const config = readConfig() as {
      llm: { callSites: Record<string, Record<string, unknown>> };
    };
    expect(config.llm.callSites.memoryRouter).toEqual({
      model: "claude-sonnet-4-6",
      contextWindow: { maxInputTokens: 1_000_000 },
    });
  });

  test("preserves an existing user override on memoryRouter", () => {
    writeConfig({
      llm: {
        default: { provider: "anthropic" },
        callSites: {
          memoryRouter: {
            model: "claude-haiku-4-5-20251001",
            effort: "low",
          },
        },
      },
    });

    seedMemoryRouterCallsiteMigration.run(workspaceDir);

    const config = readConfig() as {
      llm: { callSites: Record<string, Record<string, unknown>> };
    };
    expect(config.llm.callSites.memoryRouter).toEqual({
      model: "claude-haiku-4-5-20251001",
      effort: "low",
    });
  });

  test("skips entirely when provider is non-Anthropic", () => {
    writeConfig({
      llm: { default: { provider: "openai", model: "gpt-5.4" } },
    });

    seedMemoryRouterCallsiteMigration.run(workspaceDir);

    const config = readConfig() as {
      llm: { callSites?: Record<string, unknown> };
    };
    expect(config.llm.callSites).toBeUndefined();
  });

  test("seeds when default.provider is unset (defaults to Anthropic)", () => {
    writeConfig({ llm: {} });

    seedMemoryRouterCallsiteMigration.run(workspaceDir);

    const config = readConfig() as {
      llm: { callSites: Record<string, Record<string, unknown>> };
    };
    expect(config.llm.callSites.memoryRouter).toEqual({
      model: "claude-sonnet-4-6",
      contextWindow: { maxInputTokens: 1_000_000 },
    });
  });

  test("skips when VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH is set", () => {
    process.env.VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH = "/tmp/overlay.json";
    writeConfig({ llm: { default: { provider: "anthropic" } } });

    seedMemoryRouterCallsiteMigration.run(workspaceDir);

    const config = readConfig() as {
      llm: { callSites?: Record<string, unknown> };
    };
    expect(config.llm.callSites).toBeUndefined();
  });

  test("preserves sibling call-site entries when seeding memoryRouter", () => {
    writeConfig({
      llm: {
        default: { provider: "anthropic" },
        callSites: {
          mainAgent: { model: "claude-opus-4-7", maxTokens: 32000 },
        },
      },
    });

    seedMemoryRouterCallsiteMigration.run(workspaceDir);

    const config = readConfig() as {
      llm: { callSites: Record<string, Record<string, unknown>> };
    };
    expect(config.llm.callSites.mainAgent).toEqual({
      model: "claude-opus-4-7",
      maxTokens: 32000,
    });
    expect(config.llm.callSites.memoryRouter).toEqual({
      model: "claude-sonnet-4-6",
      contextWindow: { maxInputTokens: 1_000_000 },
    });
  });
});
