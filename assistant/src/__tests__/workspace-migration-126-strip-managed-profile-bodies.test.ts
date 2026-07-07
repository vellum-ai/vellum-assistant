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

import { stripManagedProfileBodiesMigration } from "../workspace/migrations/126-strip-managed-profile-bodies.js";

let workspaceDir: string;

function freshWorkspace(): void {
  workspaceDir = join(
    tmpdir(),
    `vellum-migration-126-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

/** A fully seeded managed body as pre-migration installs carry on disk. */
const SEEDED_BALANCED = {
  source: "managed",
  provider: "fireworks",
  provider_connection: "vellum",
  model: "accounts/fireworks/models/glm-5p2",
  label: "Balanced (Managed)",
  description: "Good balance of quality, cost, and speed",
  maxTokens: 32000,
  effort: "high",
  status: "disabled",
  topP: 0.9,
  thinking: { enabled: true, streamThinking: true },
  contextWindow: { maxInputTokens: 200000 },
};

describe("126-strip-managed-profile-bodies", () => {
  test("strips a seeded managed body to a thin stub carrying label/status/topP", () => {
    writeConfig({
      llm: {
        profiles: {
          balanced: SEEDED_BALANCED,
          "quality-optimized": {
            source: "managed",
            provider: "anthropic",
            model: "claude-fable-5",
            maxTokens: 32000,
          },
        },
      },
    });

    stripManagedProfileBodiesMigration.run(workspaceDir);

    const profiles = (readConfig().llm as Record<string, unknown>)
      .profiles as Record<string, Record<string, unknown>>;
    expect(profiles.balanced).toEqual({
      source: "managed",
      label: "Balanced (Managed)",
      status: "disabled",
      topP: 0.9,
    });
    expect(profiles["quality-optimized"]).toEqual({ source: "managed" });
  });

  test("leaves custom profiles and user-source shadows byte-identical", () => {
    const custom = {
      source: "user",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      maxTokens: 4096,
    };
    const shadow = {
      source: "user",
      provider: "openai",
      model: "gpt-5.4",
      label: "My Balanced",
    };
    writeConfig({
      llm: {
        profiles: {
          "my-custom": custom,
          balanced: shadow,
          "cost-optimized": { source: "managed", model: "stale" },
        },
      },
    });

    stripManagedProfileBodiesMigration.run(workspaceDir);

    const profiles = (readConfig().llm as Record<string, unknown>)
      .profiles as Record<string, Record<string, unknown>>;
    expect(profiles["my-custom"]).toEqual(custom);
    expect(profiles.balanced).toEqual(shadow);
    expect(profiles["cost-optimized"]).toEqual({ source: "managed" });
  });

  test("strips a managed os-beta body to a stub", () => {
    writeConfig({
      llm: {
        profiles: {
          "os-beta": {
            source: "managed",
            provider: "together",
            model: "MiniMaxAI/MiniMax-M3",
            label: "OS Beta",
            topP: 0.95,
          },
        },
      },
    });

    stripManagedProfileBodiesMigration.run(workspaceDir);

    const profiles = (readConfig().llm as Record<string, unknown>)
      .profiles as Record<string, Record<string, unknown>>;
    expect(profiles["os-beta"]).toEqual({
      source: "managed",
      label: "OS Beta",
      topP: 0.95,
    });
  });

  test("is idempotent and no-ops on already-thin stubs and missing config", () => {
    stripManagedProfileBodiesMigration.run(workspaceDir);
    expect(existsSync(join(workspaceDir, "config.json"))).toBe(false);

    writeConfig({
      llm: {
        profiles: {
          balanced: { source: "managed", status: "disabled" },
        },
      },
    });
    stripManagedProfileBodiesMigration.run(workspaceDir);
    const first = readFileSync(join(workspaceDir, "config.json"), "utf-8");
    stripManagedProfileBodiesMigration.run(workspaceDir);
    const second = readFileSync(join(workspaceDir, "config.json"), "utf-8");
    expect(second).toBe(first);
  });
});
