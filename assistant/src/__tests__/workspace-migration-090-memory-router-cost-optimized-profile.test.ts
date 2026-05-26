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

import { memoryRouterCostOptimizedProfileMigration } from "../workspace/migrations/090-memory-router-cost-optimized-profile.js";

let workspaceDir: string;

function freshWorkspace(): void {
  workspaceDir = join(
    tmpdir(),
    `vellum-migration-090-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

describe("090-memory-router-cost-optimized-profile migration", () => {
  test("has correct migration id", () => {
    expect(memoryRouterCostOptimizedProfileMigration.id).toBe(
      "090-memory-router-cost-optimized-profile",
    );
  });

  test("flips the 087-seeded balanced profile to cost-optimized with 1M context", () => {
    writeConfig({
      llm: {
        default: { provider: "anthropic" },
        callSites: {
          memoryRouter: { profile: "balanced" },
        },
      },
    });

    memoryRouterCostOptimizedProfileMigration.run(workspaceDir);

    const config = readConfig() as {
      llm: { callSites: Record<string, Record<string, unknown>> };
    };
    // Must mirror the shipped default in call-site-defaults.ts: dropping the
    // contextWindow would regress migrated users to the profile's ~200k window
    // because the resolver prefers an explicit callSites entry.
    expect(config.llm.callSites.memoryRouter).toEqual({
      profile: "cost-optimized",
      contextWindow: { maxInputTokens: 1_000_000 },
    });
  });

  test("flips when default provider is absent (treated as Anthropic)", () => {
    writeConfig({
      llm: {
        callSites: {
          memoryRouter: { profile: "balanced" },
        },
      },
    });

    memoryRouterCostOptimizedProfileMigration.run(workspaceDir);

    const config = readConfig() as {
      llm: { callSites: Record<string, Record<string, unknown>> };
    };
    expect(config.llm.callSites.memoryRouter).toEqual({
      profile: "cost-optimized",
      contextWindow: { maxInputTokens: 1_000_000 },
    });
  });

  test("upgrades a bare cost-optimized entry left by a pre-fix run to add 1M context", () => {
    // An earlier (pre-fix) run of this migration wrote a bare
    // { profile: "cost-optimized" } with no contextWindow. Re-running must
    // recover the 1M window for those users.
    writeConfig({
      llm: {
        default: { provider: "anthropic" },
        callSites: {
          memoryRouter: { profile: "cost-optimized" },
        },
      },
    });

    memoryRouterCostOptimizedProfileMigration.run(workspaceDir);

    const config = readConfig() as {
      llm: { callSites: Record<string, Record<string, unknown>> };
    };
    expect(config.llm.callSites.memoryRouter).toEqual({
      profile: "cost-optimized",
      contextWindow: { maxInputTokens: 1_000_000 },
    });
  });

  test("does not create the call site when missing — shipped default handles it", () => {
    // Fresh installs and BYOK-skipped-by-087 workspaces have no memoryRouter
    // entry. The shipped default in call-site-defaults.ts already supplies
    // cost-optimized + 1M context, so this migration should not write anything.
    writeConfig({
      llm: { default: { provider: "anthropic" } },
    });

    const before = readFileSync(configPath(), "utf-8");
    memoryRouterCostOptimizedProfileMigration.run(workspaceDir);
    const after = readFileSync(configPath(), "utf-8");

    expect(after).toBe(before);
  });

  test("does nothing when config.json is absent", () => {
    memoryRouterCostOptimizedProfileMigration.run(workspaceDir);
    expect(existsSync(configPath())).toBe(false);
  });

  test("skips BYOK / non-Anthropic workspaces to avoid breaking memoryRouter", () => {
    // `cost-optimized` resolves to a managed connection that BYOK installs
    // disable. Rewriting there would silently disable memory injection.
    writeConfig({
      llm: {
        default: { provider: "openai", model: "gpt-5.4" },
        callSites: {
          memoryRouter: { profile: "balanced" },
        },
      },
    });

    memoryRouterCostOptimizedProfileMigration.run(workspaceDir);

    const config = readConfig() as {
      llm: { callSites: Record<string, Record<string, unknown>> };
    };
    expect(config.llm.callSites.memoryRouter).toEqual({ profile: "balanced" });
  });

  test("skips BYOK workspaces with no existing memoryRouter entry", () => {
    writeConfig({
      llm: { default: { provider: "gemini" } },
    });

    memoryRouterCostOptimizedProfileMigration.run(workspaceDir);

    const config = readConfig() as {
      llm: { callSites?: Record<string, Record<string, unknown>> };
    };
    expect(config.llm.callSites?.memoryRouter).toBeUndefined();
  });

  test("preserves user customizations (model pin)", () => {
    writeConfig({
      llm: {
        default: { provider: "anthropic" },
        callSites: {
          memoryRouter: { model: "claude-sonnet-4-6" },
        },
      },
    });

    memoryRouterCostOptimizedProfileMigration.run(workspaceDir);

    const config = readConfig() as {
      llm: { callSites: Record<string, Record<string, unknown>> };
    };
    expect(config.llm.callSites.memoryRouter).toEqual({
      model: "claude-sonnet-4-6",
    });
  });

  test("preserves user customizations (profile + tuning fields)", () => {
    writeConfig({
      llm: {
        default: { provider: "anthropic" },
        callSites: {
          memoryRouter: { profile: "balanced", effort: "low" },
        },
      },
    });

    memoryRouterCostOptimizedProfileMigration.run(workspaceDir);

    const config = readConfig() as {
      llm: { callSites: Record<string, Record<string, unknown>> };
    };
    expect(config.llm.callSites.memoryRouter).toEqual({
      profile: "balanced",
      effort: "low",
    });
  });

  test("preserves the original 077-seeded shape if still present", () => {
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

    memoryRouterCostOptimizedProfileMigration.run(workspaceDir);

    const config = readConfig() as {
      llm: { callSites: Record<string, Record<string, unknown>> };
    };
    expect(config.llm.callSites.memoryRouter).toEqual({
      model: "claude-sonnet-4-6",
      contextWindow: { maxInputTokens: 1_000_000 },
    });
  });

  test("preserves quality-optimized override", () => {
    writeConfig({
      llm: {
        default: { provider: "anthropic" },
        callSites: {
          memoryRouter: { profile: "quality-optimized" },
        },
      },
    });

    memoryRouterCostOptimizedProfileMigration.run(workspaceDir);

    const config = readConfig() as {
      llm: { callSites: Record<string, Record<string, unknown>> };
    };
    expect(config.llm.callSites.memoryRouter).toEqual({
      profile: "quality-optimized",
    });
  });

  test("is idempotent — second run does not change the call site", () => {
    writeConfig({
      llm: {
        default: { provider: "anthropic" },
        callSites: {
          memoryRouter: { profile: "balanced" },
        },
      },
    });

    memoryRouterCostOptimizedProfileMigration.run(workspaceDir);
    const afterFirst = readFileSync(configPath(), "utf-8");
    memoryRouterCostOptimizedProfileMigration.run(workspaceDir);
    const afterSecond = readFileSync(configPath(), "utf-8");

    expect(afterSecond).toBe(afterFirst);
  });

  test("skips when VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH is set", () => {
    process.env.VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH = "/tmp/overlay.json";
    writeConfig({
      llm: {
        default: { provider: "anthropic" },
        callSites: {
          memoryRouter: { profile: "balanced" },
        },
      },
    });

    memoryRouterCostOptimizedProfileMigration.run(workspaceDir);

    const config = readConfig() as {
      llm: { callSites: Record<string, Record<string, unknown>> };
    };
    expect(config.llm.callSites.memoryRouter).toEqual({ profile: "balanced" });
  });

  test("preserves sibling call-site entries", () => {
    writeConfig({
      llm: {
        default: { provider: "anthropic" },
        callSites: {
          mainAgent: { model: "claude-opus-4-7", maxTokens: 32000 },
          memoryRouter: { profile: "balanced" },
        },
      },
    });

    memoryRouterCostOptimizedProfileMigration.run(workspaceDir);

    const config = readConfig() as {
      llm: { callSites: Record<string, Record<string, unknown>> };
    };
    expect(config.llm.callSites.mainAgent).toEqual({
      model: "claude-opus-4-7",
      maxTokens: 32000,
    });
    expect(config.llm.callSites.memoryRouter).toEqual({
      profile: "cost-optimized",
      contextWindow: { maxInputTokens: 1_000_000 },
    });
  });
});
