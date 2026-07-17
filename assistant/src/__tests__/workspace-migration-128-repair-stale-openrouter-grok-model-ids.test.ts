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

import { repairStaleOpenrouterGrokModelIdsMigration } from "../workspace/migrations/128-repair-stale-openrouter-grok-model-ids.js";
import { WORKSPACE_MIGRATIONS } from "../workspace/migrations/registry.js";

let workspaceDir: string;

function freshWorkspace(): void {
  workspaceDir = join(
    tmpdir(),
    `vellum-migration-128-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

beforeEach(() => {
  freshWorkspace();
});

afterEach(() => {
  if (existsSync(workspaceDir)) {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

describe("128-repair-stale-openrouter-grok-model-ids migration", () => {
  test("has correct migration id and is registered", () => {
    expect(repairStaleOpenrouterGrokModelIdsMigration.id).toBe(
      "128-repair-stale-openrouter-grok-model-ids",
    );
    expect(WORKSPACE_MIGRATIONS.map((m) => m.id)).toContain(
      "128-repair-stale-openrouter-grok-model-ids",
    );
  });

  test("repairs stale IDs in default, call sites, and profiles", () => {
    writeConfig({
      llm: {
        default: { provider: "openrouter", model: "x-ai/grok-4.20-beta" },
        callSites: {
          recall: { model: "x-ai/grok-4", maxTokens: 4096 },
          commitMessage: { model: "x-ai/grok-4.20-beta-tuned" },
          malformed: "x-ai/grok-4.20-beta",
        },
        profiles: {
          fast: { provider: "openrouter", model: "x-ai/grok-4.20-beta" },
          legacy: { model: "x-ai/grok-4" },
        },
      },
    });

    repairStaleOpenrouterGrokModelIdsMigration.run(workspaceDir);

    const llm = readConfig().llm as Record<string, any>;
    expect(llm.default.model).toBe("x-ai/grok-4.20");
    expect(llm.callSites.recall.model).toBe("x-ai/grok-4.5");
    expect(llm.callSites.recall.maxTokens).toBe(4096);
    // Non-exact matches and malformed leaves are untouched.
    expect(llm.callSites.commitMessage.model).toBe("x-ai/grok-4.20-beta-tuned");
    expect(llm.callSites.malformed).toBe("x-ai/grok-4.20-beta");
    expect(llm.profiles.fast.model).toBe("x-ai/grok-4.20");
    expect(llm.profiles.legacy.model).toBe("x-ai/grok-4.5");
  });

  test("leaves fragments with an explicit non-OpenRouter provider untouched", () => {
    writeConfig({
      llm: {
        default: { provider: "openai-compatible", model: "x-ai/grok-4" },
        profiles: {
          byo: { provider: "openai-compatible", model: "x-ai/grok-4.20-beta" },
        },
      },
    });

    repairStaleOpenrouterGrokModelIdsMigration.run(workspaceDir);

    const llm = readConfig().llm as Record<string, any>;
    expect(llm.default.model).toBe("x-ai/grok-4");
    expect(llm.profiles.byo.model).toBe("x-ai/grok-4.20-beta");
  });

  test("is idempotent and a no-op without stale IDs", () => {
    writeConfig({
      llm: {
        default: { provider: "openrouter", model: "x-ai/grok-4.20-beta" },
        profiles: { fine: { provider: "openrouter", model: "x-ai/grok-4.5" } },
      },
    });

    repairStaleOpenrouterGrokModelIdsMigration.run(workspaceDir);
    const first = readConfig();
    repairStaleOpenrouterGrokModelIdsMigration.run(workspaceDir);
    expect(readConfig()).toEqual(first);

    const llm = first.llm as Record<string, any>;
    expect(llm.default.model).toBe("x-ai/grok-4.20");
    expect(llm.profiles.fine.model).toBe("x-ai/grok-4.5");
  });

  test("handles missing config, missing llm block, and invalid JSON", () => {
    // No config.json at all.
    expect(() =>
      repairStaleOpenrouterGrokModelIdsMigration.run(workspaceDir),
    ).not.toThrow();

    writeConfig({ theme: "dark" });
    repairStaleOpenrouterGrokModelIdsMigration.run(workspaceDir);
    expect(readConfig()).toEqual({ theme: "dark" });

    writeFileSync(join(workspaceDir, "config.json"), "{not json");
    expect(() =>
      repairStaleOpenrouterGrokModelIdsMigration.run(workspaceDir),
    ).not.toThrow();
  });
});
