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

import { seedMainAgentOpusCallsiteMigration } from "../workspace/migrations/050-seed-main-agent-opus-callsite.js";

let workspaceDir: string;

function freshWorkspace(): void {
  workspaceDir = join(
    tmpdir(),
    `vellum-migration-050-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

describe("050-seed-main-agent-opus-callsite migration", () => {
  test("has correct migration id", () => {
    expect(seedMainAgentOpusCallsiteMigration.id).toBe(
      "050-seed-main-agent-opus-callsite",
    );
  });

  test("seeds mainAgent with Opus + matching maxTokens on empty Anthropic workspace", () => {
    writeConfig({
      llm: { default: { provider: "anthropic" } },
    });

    seedMainAgentOpusCallsiteMigration.run(workspaceDir);

    const config = readConfig() as {
      llm: { callSites: Record<string, Record<string, unknown>> };
    };
    expect(config.llm.callSites.mainAgent).toEqual({
      model: "claude-opus-4-7",
      maxTokens: 32000,
    });
  });

  test("writes fresh starter config when config.json is absent", () => {
    seedMainAgentOpusCallsiteMigration.run(workspaceDir);

    expect(existsSync(configPath())).toBe(true);
    const config = readConfig() as {
      llm: { callSites: Record<string, Record<string, unknown>> };
    };
    expect(config.llm.callSites.mainAgent).toEqual({
      model: "claude-opus-4-7",
      maxTokens: 32000,
    });
  });

  test("preserves an existing user override on mainAgent", () => {
    writeConfig({
      llm: {
        default: { provider: "anthropic" },
        callSites: {
          mainAgent: {
            model: "claude-haiku-4-5-20251001",
            effort: "low",
          },
        },
      },
    });

    seedMainAgentOpusCallsiteMigration.run(workspaceDir);

    const config = readConfig() as {
      llm: { callSites: Record<string, Record<string, unknown>> };
    };
    expect(config.llm.callSites.mainAgent).toEqual({
      model: "claude-haiku-4-5-20251001",
      effort: "low",
    });
  });

  test("skips entirely when provider is non-Anthropic", () => {
    writeConfig({
      llm: { default: { provider: "openai", model: "gpt-5.4" } },
    });

    seedMainAgentOpusCallsiteMigration.run(workspaceDir);

    const config = readConfig() as {
      llm: { callSites?: Record<string, unknown> };
    };
    expect(config.llm.callSites).toBeUndefined();
  });

  test("skips when user picked a non-Opus Anthropic model explicitly", () => {
    writeConfig({
      llm: {
        default: {
          provider: "anthropic",
          model: "claude-haiku-4-5-20251001",
        },
      },
    });

    seedMainAgentOpusCallsiteMigration.run(workspaceDir);

    const config = readConfig() as {
      llm: { callSites?: Record<string, unknown> };
    };
    expect(config.llm.callSites).toBeUndefined();
  });

  test("seeds when user's default.model equals the prior default claude-opus-4-7", () => {
    writeConfig({
      llm: {
        default: { provider: "anthropic", model: "claude-opus-4-7" },
      },
    });

    seedMainAgentOpusCallsiteMigration.run(workspaceDir);

    const config = readConfig() as {
      llm: { callSites: Record<string, Record<string, unknown>> };
    };
    expect(config.llm.callSites.mainAgent).toEqual({
      model: "claude-opus-4-7",
      maxTokens: 32000,
    });
  });

  test("skips when VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH is set", () => {
    process.env.VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH = "/tmp/overlay.json";
    writeConfig({ llm: { default: { provider: "anthropic" } } });

    seedMainAgentOpusCallsiteMigration.run(workspaceDir);

    const config = readConfig() as {
      llm: { callSites?: Record<string, unknown> };
    };
    expect(config.llm.callSites).toBeUndefined();
  });
});
