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

import { swapQualityProfileToOpusMigration } from "../workspace/migrations/114-swap-quality-profile-to-opus.js";

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
  return (readConfig().llm as Record<string, unknown>).profiles as Record<
    string,
    Record<string, unknown>
  >;
}

beforeEach(() => {
  workspaceDir = join(
    tmpdir(),
    `vellum-migration-114-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(workspaceDir, { recursive: true });
});

afterEach(() => {
  if (existsSync(workspaceDir)) {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

describe("114-swap-quality-profile-to-opus migration", () => {
  test("no-op when config.json does not exist", () => {
    swapQualityProfileToOpusMigration.run(workspaceDir);
    expect(existsSync(join(workspaceDir, "config.json"))).toBe(false);
  });

  test("no-op when config has no llm.profiles", () => {
    const original = { llm: { default: { provider: "anthropic" } } };
    writeConfig(original);
    swapQualityProfileToOpusMigration.run(workspaceDir);
    expect(readConfig()).toEqual(original);
  });

  test("gracefully handles invalid JSON", () => {
    writeFileSync(join(workspaceDir, "config.json"), "not-valid-json");
    swapQualityProfileToOpusMigration.run(workspaceDir);
    expect(readFileSync(join(workspaceDir, "config.json"), "utf-8")).toBe(
      "not-valid-json",
    );
  });

  test("swaps the managed quality-optimized profile from GLM 5.2 to Opus", () => {
    writeConfig({
      llm: {
        profiles: {
          "quality-optimized": {
            source: "managed",
            provider: "fireworks",
            provider_connection: "fireworks-managed",
            model: "accounts/fireworks/models/glm-5p2",
            label: "Quality",
            description:
              "High-quality results with a leading open model (GLM 5.2)",
          },
        },
      },
    });
    swapQualityProfileToOpusMigration.run(workspaceDir);
    const profile = readProfiles()["quality-optimized"]!;
    expect(profile.model).toBe("claude-opus-4-8");
    expect(profile.provider).toBe("anthropic");
    expect(profile.provider_connection).toBe("anthropic-managed");
    expect(profile.description).toBe(
      "High-quality results with the most capable model",
    );
    // The slot's own identity (key + label) is preserved so pins keep resolving.
    expect(profile.label).toBe("Quality");
  });

  test("swaps a source-less legacy managed quality-optimized profile", () => {
    writeConfig({
      llm: {
        profiles: {
          "quality-optimized": {
            provider: "fireworks",
            provider_connection: "fireworks-managed",
            model: "accounts/fireworks/models/glm-5p2",
          },
        },
      },
    });
    swapQualityProfileToOpusMigration.run(workspaceDir);
    const profile = readProfiles()["quality-optimized"]!;
    expect(profile.model).toBe("claude-opus-4-8");
    expect(profile.provider).toBe("anthropic");
    expect(profile.provider_connection).toBe("anthropic-managed");
  });

  test("leaves a user-owned quality-optimized profile untouched", () => {
    const original = {
      llm: {
        profiles: {
          "quality-optimized": {
            source: "user",
            provider: "fireworks",
            model: "accounts/fireworks/models/glm-5p2",
          },
        },
      },
    };
    writeConfig(original);
    swapQualityProfileToOpusMigration.run(workspaceDir);
    expect(readConfig()).toEqual(original);
  });

  test("leaves a user-retargeted managed model untouched", () => {
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
    swapQualityProfileToOpusMigration.run(workspaceDir);
    expect(readConfig()).toEqual(original);
  });

  test("idempotency: no-op on already-swapped config (no writes)", () => {
    writeConfig({
      llm: {
        profiles: {
          "quality-optimized": {
            source: "managed",
            provider: "anthropic",
            provider_connection: "anthropic-managed",
            model: "claude-opus-4-8",
          },
        },
      },
    });
    const beforeContent = readFileSync(
      join(workspaceDir, "config.json"),
      "utf-8",
    );
    swapQualityProfileToOpusMigration.run(workspaceDir);
    expect(readFileSync(join(workspaceDir, "config.json"), "utf-8")).toBe(
      beforeContent,
    );
  });
});
