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

import { swapQualityProfileToGlm52Migration } from "../workspace/migrations/109-swap-quality-profile-to-glm-5p2.js";

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

function readLlm(): Record<string, unknown> {
  return readConfig().llm as Record<string, unknown>;
}

function readProfiles(): Record<string, Record<string, unknown>> {
  return readLlm().profiles as Record<string, Record<string, unknown>>;
}

beforeEach(() => {
  workspaceDir = join(
    tmpdir(),
    `vellum-migration-109-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(workspaceDir, { recursive: true });
});

afterEach(() => {
  if (existsSync(workspaceDir)) {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

describe("109-swap-quality-profile-to-glm-5p2 migration", () => {
  test("no-op when config.json does not exist", () => {
    swapQualityProfileToGlm52Migration.run(workspaceDir);
    expect(existsSync(join(workspaceDir, "config.json"))).toBe(false);
  });

  test("no-op when config has no llm.profiles", () => {
    const original = { llm: { default: { provider: "anthropic" } } };
    writeConfig(original);
    swapQualityProfileToGlm52Migration.run(workspaceDir);
    expect(readConfig()).toEqual(original);
  });

  test("gracefully handles invalid JSON", () => {
    writeFileSync(join(workspaceDir, "config.json"), "not-valid-json");
    swapQualityProfileToGlm52Migration.run(workspaceDir);
    expect(readFileSync(join(workspaceDir, "config.json"), "utf-8")).toBe(
      "not-valid-json",
    );
  });

  test("swaps managed quality-optimized from Opus 4.8 to GLM 5.2", () => {
    writeConfig({
      llm: {
        profiles: {
          "quality-optimized": {
            source: "managed",
            provider: "anthropic",
            provider_connection: "anthropic-managed",
            model: "claude-opus-4-8",
            label: "Quality",
            advisorEnabled: false,
          },
        },
      },
    });
    swapQualityProfileToGlm52Migration.run(workspaceDir);
    const profile = readProfiles()["quality-optimized"]!;
    expect(profile.model).toBe("accounts/fireworks/models/glm-5p2");
    expect(profile.provider).toBe("fireworks");
    expect(profile.provider_connection).toBe("fireworks-managed");
    expect(profile.label).toBe("Quality");
    // `advisorEnabled` is left as persisted — deleting it could reverse an
    // explicit user preference (the old seeded default was also `false`).
    expect(profile.advisorEnabled).toBe(false);
  });

  test("swaps OpenRouter-prefixed Opus model ids", () => {
    writeConfig({
      llm: {
        profiles: {
          "quality-optimized": {
            source: "managed",
            provider: "openrouter",
            model: "anthropic/claude-opus-4.8",
          },
        },
      },
    });
    swapQualityProfileToGlm52Migration.run(workspaceDir);
    const profile = readProfiles()["quality-optimized"]!;
    expect(profile.model).toBe("accounts/fireworks/models/glm-5p2");
    expect(profile.provider).toBe("fireworks");
    expect(profile.provider_connection).toBe("fireworks-managed");
  });

  test("swaps a source-less legacy managed quality-optimized", () => {
    // Migration 052 seeded canonical profiles without a `source`; absent source
    // on this reserved name means legacy managed, so it must still be swapped.
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
    swapQualityProfileToGlm52Migration.run(workspaceDir);
    const profile = readProfiles()["quality-optimized"]!;
    expect(profile.model).toBe("accounts/fireworks/models/glm-5p2");
    expect(profile.provider).toBe("fireworks");
  });

  test("leaves a user-owned quality-optimized copy untouched", () => {
    const original = {
      llm: {
        profiles: {
          "quality-optimized": {
            source: "user",
            provider: "anthropic",
            model: "claude-opus-4-8",
          },
        },
      },
    };
    writeConfig(original);
    swapQualityProfileToGlm52Migration.run(workspaceDir);
    expect(readConfig()).toEqual(original);
  });

  test("leaves a user-customized managed model untouched", () => {
    const original = {
      llm: {
        profiles: {
          "quality-optimized": {
            source: "managed",
            provider: "openai",
            model: "gpt-5.4",
          },
        },
      },
    };
    writeConfig(original);
    swapQualityProfileToGlm52Migration.run(workspaceDir);
    expect(readConfig()).toEqual(original);
  });

  test("preserves a user-toggled advisorEnabled override", () => {
    writeConfig({
      llm: {
        profiles: {
          "quality-optimized": {
            source: "managed",
            provider: "anthropic",
            model: "claude-opus-4-8",
            advisorEnabled: true,
          },
        },
      },
    });
    swapQualityProfileToGlm52Migration.run(workspaceDir);
    expect(readProfiles()["quality-optimized"]!.advisorEnabled).toBe(true);
  });

  test("repoints the default advisor from quality-optimized to frontier", () => {
    writeConfig({
      llm: {
        advisorProfile: "quality-optimized",
        profiles: {
          "quality-optimized": {
            source: "managed",
            provider: "anthropic",
            model: "claude-opus-4-8",
          },
        },
      },
    });
    swapQualityProfileToGlm52Migration.run(workspaceDir);
    expect(readLlm().advisorProfile).toBe("frontier");
  });

  test("does not repoint the advisor when a user owns a frontier profile", () => {
    writeConfig({
      llm: {
        advisorProfile: "quality-optimized",
        profiles: {
          "quality-optimized": {
            source: "managed",
            provider: "anthropic",
            model: "claude-opus-4-8",
          },
          frontier: { source: "user", provider: "openai", model: "gpt-5.4" },
        },
      },
    });
    swapQualityProfileToGlm52Migration.run(workspaceDir);
    // The seeder leaves the user's `frontier` in place rather than creating the
    // managed Opus one, so the advisor stays on managed GLM 5.2 (quality).
    expect(readLlm().advisorProfile).toBe("quality-optimized");
  });

  test("does not repoint the advisor when a source-less frontier exists", () => {
    // Custom profiles from the settings UI are saved without a `source`.
    writeConfig({
      llm: {
        advisorProfile: "quality-optimized",
        profiles: {
          "quality-optimized": {
            source: "managed",
            provider: "anthropic",
            model: "claude-opus-4-8",
          },
          frontier: { provider: "openai", model: "gpt-5.4" },
        },
      },
    });
    swapQualityProfileToGlm52Migration.run(workspaceDir);
    expect(readLlm().advisorProfile).toBe("quality-optimized");
  });

  test("leaves a custom advisor profile untouched", () => {
    writeConfig({
      llm: {
        advisorProfile: "balanced",
        profiles: {
          "quality-optimized": {
            source: "managed",
            provider: "anthropic",
            model: "claude-opus-4-8",
          },
        },
      },
    });
    swapQualityProfileToGlm52Migration.run(workspaceDir);
    expect(readLlm().advisorProfile).toBe("balanced");
  });

  test("idempotency: no-op on already-swapped config (no writes)", () => {
    writeConfig({
      llm: {
        advisorProfile: "frontier",
        profiles: {
          "quality-optimized": {
            source: "managed",
            provider: "fireworks",
            provider_connection: "fireworks-managed",
            model: "accounts/fireworks/models/glm-5p2",
          },
        },
      },
    });
    const beforeContent = readFileSync(
      join(workspaceDir, "config.json"),
      "utf-8",
    );
    swapQualityProfileToGlm52Migration.run(workspaceDir);
    expect(readFileSync(join(workspaceDir, "config.json"), "utf-8")).toBe(
      beforeContent,
    );
  });
});
