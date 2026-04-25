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

import { LLMSchema } from "../config/schemas/llm.js";
import { seedDefaultInferenceProfiles052 } from "../workspace/migrations/052-seed-default-inference-profiles.js";

let workspaceDir: string;

function freshWorkspace(): void {
  workspaceDir = join(
    tmpdir(),
    `vellum-migration-052-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

const ANTHROPIC_QUALITY = {
  provider: "anthropic",
  model: "claude-opus-4-7",
  maxTokens: 32000,
  effort: "max",
  thinking: { enabled: true, streamThinking: true },
};

const ANTHROPIC_BALANCED = {
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  maxTokens: 16000,
  effort: "high",
  thinking: { enabled: true, streamThinking: true },
};

const ANTHROPIC_COST = {
  provider: "anthropic",
  model: "claude-haiku-4-5-20251001",
  maxTokens: 8192,
  effort: "low",
  thinking: { enabled: false, streamThinking: false },
};

describe("052-seed-default-inference-profiles migration", () => {
  test("has correct migration id", () => {
    expect(seedDefaultInferenceProfiles052.id).toBe(
      "052-seed-default-inference-profiles",
    );
  });

  test("seeds all three profiles + activeProfile=balanced on Anthropic workspace", () => {
    writeConfig({
      llm: { default: { provider: "anthropic" } },
    });

    seedDefaultInferenceProfiles052.run(workspaceDir);

    const config = readConfig() as {
      llm: {
        profiles: Record<string, Record<string, unknown>>;
        activeProfile: string;
      };
    };
    expect(config.llm.profiles["quality-optimized"]).toEqual(ANTHROPIC_QUALITY);
    expect(config.llm.profiles.balanced).toEqual(ANTHROPIC_BALANCED);
    expect(config.llm.profiles["cost-optimized"]).toEqual(ANTHROPIC_COST);
    expect(config.llm.activeProfile).toBe("balanced");
  });

  test("defaults to Anthropic seeding when llm.default.provider is absent", () => {
    writeConfig({});

    seedDefaultInferenceProfiles052.run(workspaceDir);

    const config = readConfig() as {
      llm: {
        profiles: Record<string, Record<string, unknown>>;
        activeProfile: string;
      };
    };
    expect(config.llm.profiles.balanced).toEqual(ANTHROPIC_BALANCED);
    expect(config.llm.activeProfile).toBe("balanced");
  });

  test("is idempotent — second run produces identical bytes", () => {
    writeConfig({
      llm: { default: { provider: "anthropic" } },
    });

    seedDefaultInferenceProfiles052.run(workspaceDir);
    const afterFirst = readFileSync(configPath(), "utf-8");
    seedDefaultInferenceProfiles052.run(workspaceDir);
    const afterSecond = readFileSync(configPath(), "utf-8");

    expect(afterSecond).toBe(afterFirst);
  });

  test("preserves an existing user-defined quality-optimized profile", () => {
    const userProfile = {
      provider: "anthropic",
      model: "claude-opus-4-6",
      maxTokens: 8000,
      effort: "low",
    };
    writeConfig({
      llm: {
        default: { provider: "anthropic" },
        profiles: { "quality-optimized": userProfile },
      },
    });

    seedDefaultInferenceProfiles052.run(workspaceDir);

    const config = readConfig() as {
      llm: { profiles: Record<string, Record<string, unknown>> };
    };
    expect(config.llm.profiles["quality-optimized"]).toEqual(userProfile);
    // The other two slots still get seeded with the defaults.
    expect(config.llm.profiles.balanced).toEqual(ANTHROPIC_BALANCED);
    expect(config.llm.profiles["cost-optimized"]).toEqual(ANTHROPIC_COST);
  });

  test("preserves an existing activeProfile on Anthropic workspaces", () => {
    writeConfig({
      llm: {
        default: { provider: "anthropic" },
        activeProfile: "quality-optimized",
      },
    });

    seedDefaultInferenceProfiles052.run(workspaceDir);

    const config = readConfig() as {
      llm: { activeProfile: string };
    };
    expect(config.llm.activeProfile).toBe("quality-optimized");
  });

  test("non-Anthropic provider seeds empty shells but no activeProfile", () => {
    writeConfig({
      llm: { default: { provider: "openai", model: "gpt-5.4" } },
    });

    seedDefaultInferenceProfiles052.run(workspaceDir);

    const config = readConfig() as {
      llm: {
        profiles: Record<string, Record<string, unknown>>;
        activeProfile?: string;
      };
    };
    expect(config.llm.profiles["quality-optimized"]).toEqual({});
    expect(config.llm.profiles.balanced).toEqual({});
    expect(config.llm.profiles["cost-optimized"]).toEqual({});
    expect(config.llm.activeProfile).toBeUndefined();
  });

  test("does not touch existing llm.callSites entries", () => {
    writeConfig({
      llm: {
        default: { provider: "anthropic" },
        callSites: {
          interactionClassifier: { model: "claude-haiku-4-5-20251001" },
          mainAgent: { model: "claude-opus-4-7", maxTokens: 32000 },
        },
      },
    });

    seedDefaultInferenceProfiles052.run(workspaceDir);

    const config = readConfig() as {
      llm: { callSites: Record<string, Record<string, unknown>> };
    };
    expect(config.llm.callSites.interactionClassifier).toEqual({
      model: "claude-haiku-4-5-20251001",
    });
    expect(config.llm.callSites.mainAgent).toEqual({
      model: "claude-opus-4-7",
      maxTokens: 32000,
    });
  });

  test("skips entirely when VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH is set", () => {
    process.env.VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH = "/tmp/overlay.json";
    writeConfig({ llm: { default: { provider: "anthropic" } } });

    seedDefaultInferenceProfiles052.run(workspaceDir);

    const config = readConfig() as {
      llm: { profiles?: Record<string, unknown>; activeProfile?: string };
    };
    expect(config.llm.profiles).toBeUndefined();
    expect(config.llm.activeProfile).toBeUndefined();
  });

  test("writes fresh starter config when config.json is absent (Anthropic default)", () => {
    seedDefaultInferenceProfiles052.run(workspaceDir);

    expect(existsSync(configPath())).toBe(true);
    const config = readConfig() as {
      llm: {
        profiles: Record<string, Record<string, unknown>>;
        activeProfile: string;
      };
    };
    expect(config.llm.profiles.balanced).toEqual(ANTHROPIC_BALANCED);
    expect(config.llm.activeProfile).toBe("balanced");
  });

  test("seeded config parses cleanly through LLMSchema", () => {
    writeConfig({
      llm: { default: { provider: "anthropic" } },
    });

    seedDefaultInferenceProfiles052.run(workspaceDir);

    const onDisk = readConfig() as { llm: unknown };
    const parsed = LLMSchema.parse(onDisk.llm);
    expect(Object.keys(parsed.profiles ?? {})).toEqual(
      expect.arrayContaining([
        "quality-optimized",
        "balanced",
        "cost-optimized",
      ]),
    );
    expect(parsed.activeProfile).toBe("balanced");
  });
});
