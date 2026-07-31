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

import { swapBalancedProfileToGlm52Migration } from "../workspace/migrations/113-swap-balanced-profile-to-glm-5p2.js";

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
    `vellum-migration-113-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(workspaceDir, { recursive: true });
});

afterEach(() => {
  if (existsSync(workspaceDir)) {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

describe("113-swap-balanced-profile-to-glm-5p2 migration", () => {
  test("no-op when config.json does not exist", () => {
    swapBalancedProfileToGlm52Migration.run(workspaceDir);
    expect(existsSync(join(workspaceDir, "config.json"))).toBe(false);
  });

  test("no-op when config has no llm.profiles", () => {
    const original = { llm: { default: { provider: "anthropic" } } };
    writeConfig(original);
    swapBalancedProfileToGlm52Migration.run(workspaceDir);
    expect(readConfig()).toEqual(original);
  });

  test("gracefully handles invalid JSON", () => {
    writeFileSync(join(workspaceDir, "config.json"), "not-valid-json");
    swapBalancedProfileToGlm52Migration.run(workspaceDir);
    expect(readFileSync(join(workspaceDir, "config.json"), "utf-8")).toBe(
      "not-valid-json",
    );
  });

  test("swaps the managed balanced profile from Together MiniMax to GLM 5.2", () => {
    writeConfig({
      llm: {
        profiles: {
          balanced: {
            source: "managed",
            provider: "together",
            provider_connection: "together-managed",
            model: "MiniMaxAI/MiniMax-M3",
            label: "Balanced",
            effort: "medium",
            description: "Good balance of quality, cost, and speed",
            topP: 0.95,
          },
        },
      },
    });
    swapBalancedProfileToGlm52Migration.run(workspaceDir);
    const profile = readProfiles().balanced!;
    expect(profile.model).toBe("accounts/fireworks/models/glm-5p2");
    expect(profile.provider).toBe("fireworks");
    expect(profile.provider_connection).toBe("fireworks-managed");
    expect(profile.effort).toBe("high");
    // The seeded default topP (0.95) is dropped — GLM 5.2 carries no topP.
    expect("topP" in profile).toBe(false);
    // The slot's own identity (key + label + description) is preserved so pins
    // keep resolving.
    expect(profile.label).toBe("Balanced");
    expect(profile.description).toBe(
      "Good balance of quality, cost, and speed",
    );
  });

  test("swaps a source-less legacy managed balanced profile", () => {
    // Migration 052 seeded canonical profiles without a `source`; absent source
    // on this reserved name means legacy managed, so it must still be swapped.
    writeConfig({
      llm: {
        profiles: {
          balanced: {
            provider: "together",
            provider_connection: "together-managed",
            model: "MiniMaxAI/MiniMax-M3",
          },
        },
      },
    });
    swapBalancedProfileToGlm52Migration.run(workspaceDir);
    const profile = readProfiles().balanced!;
    expect(profile.model).toBe("accounts/fireworks/models/glm-5p2");
    expect(profile.provider).toBe("fireworks");
    expect(profile.provider_connection).toBe("fireworks-managed");
  });

  test("preserves a user-customized topP override", () => {
    writeConfig({
      llm: {
        profiles: {
          balanced: {
            source: "managed",
            provider: "together",
            provider_connection: "together-managed",
            model: "MiniMaxAI/MiniMax-M3",
            topP: 0.5,
          },
        },
      },
    });
    swapBalancedProfileToGlm52Migration.run(workspaceDir);
    const profile = readProfiles().balanced!;
    expect(profile.model).toBe("accounts/fireworks/models/glm-5p2");
    expect(profile.topP).toBe(0.5);
  });

  test("strips a stale seeded topP from a balanced profile already reseeded to GLM", () => {
    // A failed-DB boot skips the migration runner but still runs the seeder,
    // which rewrites the model to GLM while carrying the old topP: 0.95 by
    // key-presence. On the next healthy boot this migration must still strip it.
    writeConfig({
      llm: {
        profiles: {
          balanced: {
            source: "managed",
            provider: "fireworks",
            provider_connection: "fireworks-managed",
            model: "accounts/fireworks/models/glm-5p2",
            effort: "high",
            topP: 0.95,
          },
        },
      },
    });
    swapBalancedProfileToGlm52Migration.run(workspaceDir);
    const profile = readProfiles().balanced!;
    expect(profile.model).toBe("accounts/fireworks/models/glm-5p2");
    expect("topP" in profile).toBe(false);
  });

  test("preserves a user-customized topP on a profile already reseeded to GLM", () => {
    writeConfig({
      llm: {
        profiles: {
          balanced: {
            source: "managed",
            provider: "fireworks",
            provider_connection: "fireworks-managed",
            model: "accounts/fireworks/models/glm-5p2",
            topP: 0.5,
          },
        },
      },
    });
    swapBalancedProfileToGlm52Migration.run(workspaceDir);
    expect(readProfiles().balanced!.topP).toBe(0.5);
  });

  test("leaves a user-owned balanced profile untouched", () => {
    const original = {
      llm: {
        profiles: {
          balanced: {
            source: "user",
            provider: "together",
            model: "MiniMaxAI/MiniMax-M3",
          },
        },
      },
    };
    writeConfig(original);
    swapBalancedProfileToGlm52Migration.run(workspaceDir);
    expect(readConfig()).toEqual(original);
  });

  test("leaves a user-retargeted managed model untouched", () => {
    const original = {
      llm: {
        profiles: {
          balanced: {
            source: "managed",
            provider: "anthropic",
            model: "claude-sonnet-4-6",
          },
        },
      },
    };
    writeConfig(original);
    swapBalancedProfileToGlm52Migration.run(workspaceDir);
    expect(readConfig()).toEqual(original);
  });

  test("idempotency: no-op on already-swapped config (no writes)", () => {
    writeConfig({
      llm: {
        profiles: {
          balanced: {
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
    swapBalancedProfileToGlm52Migration.run(workspaceDir);
    expect(readFileSync(join(workspaceDir, "config.json"), "utf-8")).toBe(
      beforeContent,
    );
  });
});
