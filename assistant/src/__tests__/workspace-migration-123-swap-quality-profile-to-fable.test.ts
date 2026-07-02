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

import { swapQualityProfileToFableMigration } from "../workspace/migrations/123-swap-quality-profile-to-fable.js";

let workspaceDir: string;

function writeConfig(data: Record<string, unknown>): void {
  writeFileSync(
    join(workspaceDir, "config.json"),
    JSON.stringify(data, null, 2) + "\n",
  );
}

function readConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(workspaceDir, "config.json"), "utf-8"));
}

function readProfiles(): Record<string, Record<string, unknown>> {
  const llm = readConfig().llm as Record<string, unknown>;
  return llm.profiles as Record<string, Record<string, unknown>>;
}

beforeEach(() => {
  workspaceDir = join(
    tmpdir(),
    `vellum-migration-123-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(workspaceDir, { recursive: true });
});

afterEach(() => {
  if (existsSync(workspaceDir)) {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

describe("123-swap-quality-profile-to-fable migration", () => {
  test("no-op when config.json does not exist", () => {
    swapQualityProfileToFableMigration.run(workspaceDir);
    expect(existsSync(join(workspaceDir, "config.json"))).toBe(false);
  });

  test("no-op when config has no llm.profiles", () => {
    const original = { llm: { default: { provider: "anthropic" } } };
    writeConfig(original);
    swapQualityProfileToFableMigration.run(workspaceDir);
    expect(readConfig()).toEqual(original);
  });

  test("gracefully handles invalid JSON", () => {
    writeFileSync(join(workspaceDir, "config.json"), "not-valid-json");
    swapQualityProfileToFableMigration.run(workspaceDir);
    expect(readFileSync(join(workspaceDir, "config.json"), "utf-8")).toBe(
      "not-valid-json",
    );
  });

  test("swaps quality-optimized from claude-opus-4-8", () => {
    writeConfig({
      llm: {
        profiles: {
          "quality-optimized": {
            provider: "anthropic",
            model: "claude-opus-4-8",
            label: "Quality",
          },
        },
      },
    });
    swapQualityProfileToFableMigration.run(workspaceDir);
    const profile = readProfiles()["quality-optimized"]!;
    expect(profile.model).toBe("claude-fable-5");
    expect(profile.label).toBe("Quality");
  });

  test("swaps the managed profile but not the user-owned custom copy", () => {
    writeConfig({
      llm: {
        profiles: {
          "quality-optimized": {
            provider: "anthropic",
            model: "claude-opus-4-8",
          },
          "custom-quality-optimized": {
            provider: "anthropic",
            model: "claude-opus-4-8",
          },
        },
      },
    });
    swapQualityProfileToFableMigration.run(workspaceDir);
    const profiles = readProfiles();
    expect(profiles["quality-optimized"]!.model).toBe("claude-fable-5");
    expect(profiles["custom-quality-optimized"]!.model).toBe("claude-opus-4-8");
  });

  test("swaps OpenRouter-prefixed model ids", () => {
    writeConfig({
      llm: {
        profiles: {
          "quality-optimized": {
            provider: "openrouter",
            model: "anthropic/claude-opus-4.8",
          },
        },
      },
    });
    swapQualityProfileToFableMigration.run(workspaceDir);
    expect(readProfiles()["quality-optimized"]!.model).toBe(
      "anthropic/claude-fable-5",
    );
  });

  test("leaves a user-owned (source: user) profile untouched", () => {
    const original = {
      llm: {
        profiles: {
          "quality-optimized": {
            provider: "anthropic",
            model: "claude-opus-4-8",
            source: "user",
          },
        },
      },
    };
    writeConfig(original);
    swapQualityProfileToFableMigration.run(workspaceDir);
    expect(readConfig()).toEqual(original);
  });

  test("leaves user-customized models untouched", () => {
    const original = {
      llm: {
        profiles: {
          "quality-optimized": { provider: "openai", model: "gpt-5.4" },
        },
      },
    };
    writeConfig(original);
    swapQualityProfileToFableMigration.run(workspaceDir);
    expect(readConfig()).toEqual(original);
  });

  test("leaves non-quality profiles untouched", () => {
    writeConfig({
      llm: {
        profiles: {
          balanced: { provider: "anthropic", model: "claude-opus-4-8" },
          "quality-optimized": {
            provider: "anthropic",
            model: "claude-opus-4-8",
          },
        },
      },
    });
    swapQualityProfileToFableMigration.run(workspaceDir);
    const profiles = readProfiles();
    expect(profiles["balanced"]!.model).toBe("claude-opus-4-8");
    expect(profiles["quality-optimized"]!.model).toBe("claude-fable-5");
  });

  test("idempotency: no-op on already-swapped config (no writes)", () => {
    writeConfig({
      llm: {
        profiles: {
          "quality-optimized": {
            provider: "anthropic",
            model: "claude-fable-5",
          },
        },
      },
    });
    const beforeContent = readFileSync(
      join(workspaceDir, "config.json"),
      "utf-8",
    );
    swapQualityProfileToFableMigration.run(workspaceDir);
    expect(readFileSync(join(workspaceDir, "config.json"), "utf-8")).toBe(
      beforeContent,
    );
  });
});
