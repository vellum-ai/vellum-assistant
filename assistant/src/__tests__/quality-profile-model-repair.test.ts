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

import { repairQualityProfileModel } from "../workspace/quality-profile-model-repair.js";

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
    `vellum-quality-repair-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(workspaceDir, { recursive: true });
});

afterEach(() => {
  if (existsSync(workspaceDir)) {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

describe("repairQualityProfileModel", () => {
  test("no-op when config.json does not exist", () => {
    repairQualityProfileModel(workspaceDir);
    expect(existsSync(join(workspaceDir, "config.json"))).toBe(false);
  });

  test("no-op when config has no llm.profiles", () => {
    const original = { llm: { default: { provider: "anthropic" } } };
    writeConfig(original);
    repairQualityProfileModel(workspaceDir);
    expect(readConfig()).toEqual(original);
  });

  test("gracefully handles invalid JSON", () => {
    writeFileSync(join(workspaceDir, "config.json"), "not-valid-json");
    repairQualityProfileModel(workspaceDir);
    expect(readFileSync(join(workspaceDir, "config.json"), "utf-8")).toBe(
      "not-valid-json",
    );
  });

  test("repairs an overlay-supplied Fable quality-optimized profile", () => {
    writeConfig({
      llm: {
        profiles: {
          "quality-optimized": {
            provider: "anthropic",
            model: "claude-fable-5",
            label: "Quality",
          },
        },
      },
    });
    repairQualityProfileModel(workspaceDir);
    const profile = readProfiles()["quality-optimized"]!;
    expect(profile.model).toBe("claude-opus-4-8");
    expect(profile.label).toBe("Quality");
  });

  test("repairs the managed profile but not the user-owned custom copy", () => {
    writeConfig({
      llm: {
        profiles: {
          "quality-optimized": {
            provider: "anthropic",
            model: "claude-fable-5",
          },
          "custom-quality-optimized": {
            provider: "anthropic",
            model: "claude-fable-5",
          },
        },
      },
    });
    repairQualityProfileModel(workspaceDir);
    const profiles = readProfiles();
    expect(profiles["quality-optimized"]!.model).toBe("claude-opus-4-8");
    expect(profiles["custom-quality-optimized"]!.model).toBe("claude-fable-5");
  });

  test("repairs OpenRouter-prefixed model ids", () => {
    writeConfig({
      llm: {
        profiles: {
          "quality-optimized": {
            provider: "openrouter",
            model: "anthropic/claude-fable-5",
          },
        },
      },
    });
    repairQualityProfileModel(workspaceDir);
    expect(readProfiles()["quality-optimized"]!.model).toBe(
      "anthropic/claude-opus-4.8",
    );
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
    repairQualityProfileModel(workspaceDir);
    expect(readConfig()).toEqual(original);
  });

  test("idempotency: no-op on already-repaired config (no writes)", () => {
    writeConfig({
      llm: {
        profiles: {
          "quality-optimized": {
            provider: "anthropic",
            model: "claude-opus-4-8",
          },
        },
      },
    });
    const beforeContent = readFileSync(
      join(workspaceDir, "config.json"),
      "utf-8",
    );
    repairQualityProfileModel(workspaceDir);
    expect(readFileSync(join(workspaceDir, "config.json"), "utf-8")).toBe(
      beforeContent,
    );
  });
});
