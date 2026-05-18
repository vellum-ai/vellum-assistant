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

import { memoryRouterBalancedProfileMigration } from "../workspace/migrations/087-memory-router-balanced-profile.js";

let workspaceDir: string;

function freshWorkspace(): void {
  workspaceDir = join(
    tmpdir(),
    `vellum-migration-087-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

describe("087-memory-router-balanced-profile migration", () => {
  test("has correct migration id", () => {
    expect(memoryRouterBalancedProfileMigration.id).toBe(
      "087-memory-router-balanced-profile",
    );
  });

  test("replaces seeded Sonnet 4.6 + 1M context with balanced profile", () => {
    writeConfig({
      llm: {
        default: { provider: "anthropic" },
        callSites: {
          memoryRouter: {
            model: "claude-sonnet-4-6",
            contextWindow: { maxInputTokens: 1_000_000 },
          },
        },
      },
    });

    memoryRouterBalancedProfileMigration.run(workspaceDir);

    const config = readConfig() as {
      llm: { callSites: Record<string, Record<string, unknown>> };
    };
    expect(config.llm.callSites.memoryRouter).toEqual({ profile: "balanced" });
  });

  test("creates the call site when missing", () => {
    writeConfig({
      llm: { default: { provider: "anthropic" } },
    });

    memoryRouterBalancedProfileMigration.run(workspaceDir);

    const config = readConfig() as {
      llm: { callSites: Record<string, Record<string, unknown>> };
    };
    expect(config.llm.callSites.memoryRouter).toEqual({ profile: "balanced" });
  });

  test("writes a fresh starter config when config.json is absent", () => {
    memoryRouterBalancedProfileMigration.run(workspaceDir);

    expect(existsSync(configPath())).toBe(true);
    const config = readConfig() as {
      llm: { callSites: Record<string, Record<string, unknown>> };
    };
    expect(config.llm.callSites.memoryRouter).toEqual({ profile: "balanced" });
  });

  test("skips BYOK / non-Anthropic workspaces to avoid breaking memoryRouter", () => {
    // `balanced` resolves to the managed Anthropic connection, which BYOK
    // installs disable. Rewriting to `balanced` there would silently disable
    // memory injection (getConfiguredProvider returns null). Preserve whatever
    // memoryRouter config the workspace already has — including absence.
    writeConfig({
      llm: {
        default: { provider: "openai", model: "gpt-5.4" },
        callSites: {
          memoryRouter: { model: "gpt-5.4" },
        },
      },
    });

    memoryRouterBalancedProfileMigration.run(workspaceDir);

    const config = readConfig() as {
      llm: { callSites: Record<string, Record<string, unknown>> };
    };
    expect(config.llm.callSites.memoryRouter).toEqual({ model: "gpt-5.4" });
  });

  test("skips BYOK workspaces with no existing memoryRouter entry", () => {
    writeConfig({
      llm: { default: { provider: "gemini" } },
    });

    memoryRouterBalancedProfileMigration.run(workspaceDir);

    const config = readConfig() as {
      llm: { callSites?: Record<string, Record<string, unknown>> };
    };
    expect(config.llm.callSites?.memoryRouter).toBeUndefined();
  });

  test("preserves user customizations on memoryRouter (non-077-seeded shape)", () => {
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

    memoryRouterBalancedProfileMigration.run(workspaceDir);

    const config = readConfig() as {
      llm: { callSites: Record<string, Record<string, unknown>> };
    };
    expect(config.llm.callSites.memoryRouter).toEqual({
      model: "claude-haiku-4-5-20251001",
      effort: "low",
    });
  });

  test("is idempotent — second run does not change the call site", () => {
    writeConfig({
      llm: {
        default: { provider: "anthropic" },
        callSites: {
          memoryRouter: {
            model: "claude-sonnet-4-6",
            contextWindow: { maxInputTokens: 1_000_000 },
          },
        },
      },
    });

    memoryRouterBalancedProfileMigration.run(workspaceDir);
    const afterFirst = readFileSync(configPath(), "utf-8");
    memoryRouterBalancedProfileMigration.run(workspaceDir);
    const afterSecond = readFileSync(configPath(), "utf-8");

    expect(afterSecond).toBe(afterFirst);
  });

  test("skips when VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH is set", () => {
    process.env.VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH = "/tmp/overlay.json";
    writeConfig({
      llm: {
        default: { provider: "anthropic" },
        callSites: {
          memoryRouter: { model: "claude-sonnet-4-6" },
        },
      },
    });

    memoryRouterBalancedProfileMigration.run(workspaceDir);

    const config = readConfig() as {
      llm: { callSites: Record<string, Record<string, unknown>> };
    };
    expect(config.llm.callSites.memoryRouter).toEqual({
      model: "claude-sonnet-4-6",
    });
  });

  test("preserves sibling call-site entries", () => {
    writeConfig({
      llm: {
        default: { provider: "anthropic" },
        callSites: {
          mainAgent: { model: "claude-opus-4-7", maxTokens: 32000 },
          memoryRouter: {
            model: "claude-sonnet-4-6",
            contextWindow: { maxInputTokens: 1_000_000 },
          },
        },
      },
    });

    memoryRouterBalancedProfileMigration.run(workspaceDir);

    const config = readConfig() as {
      llm: { callSites: Record<string, Record<string, unknown>> };
    };
    expect(config.llm.callSites.mainAgent).toEqual({
      model: "claude-opus-4-7",
      maxTokens: 32000,
    });
    expect(config.llm.callSites.memoryRouter).toEqual({ profile: "balanced" });
  });
});
