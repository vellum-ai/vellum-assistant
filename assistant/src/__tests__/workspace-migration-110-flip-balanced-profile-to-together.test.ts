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

import { flipBalancedProfileToTogetherMigration } from "../workspace/migrations/110-flip-balanced-profile-to-together.js";

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
    `vellum-migration-110-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(workspaceDir, { recursive: true });
});

afterEach(() => {
  if (existsSync(workspaceDir)) {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

describe("110-flip-balanced-profile-to-together migration", () => {
  test("no-op when config.json does not exist", () => {
    flipBalancedProfileToTogetherMigration.run(workspaceDir);
    expect(existsSync(join(workspaceDir, "config.json"))).toBe(false);
  });

  test("no-op when config has no llm.profiles", () => {
    const original = { llm: { default: { provider: "anthropic" } } };
    writeConfig(original);
    flipBalancedProfileToTogetherMigration.run(workspaceDir);
    expect(readConfig()).toEqual(original);
  });

  test("gracefully handles invalid JSON", () => {
    writeFileSync(join(workspaceDir, "config.json"), "not-valid-json");
    flipBalancedProfileToTogetherMigration.run(workspaceDir);
    expect(readFileSync(join(workspaceDir, "config.json"), "utf-8")).toBe(
      "not-valid-json",
    );
  });

  test("flips the managed balanced profile from Fireworks to Together", () => {
    writeConfig({
      llm: {
        profiles: {
          balanced: {
            source: "managed",
            provider: "fireworks",
            provider_connection: "fireworks-managed",
            model: "accounts/fireworks/models/minimax-m3",
            label: "Balanced",
          },
        },
      },
    });
    flipBalancedProfileToTogetherMigration.run(workspaceDir);
    const profile = readProfiles().balanced!;
    expect(profile.model).toBe("MiniMaxAI/MiniMax-M3");
    expect(profile.provider).toBe("together");
    expect(profile.provider_connection).toBe("together-managed");
    expect(profile.label).toBe("Balanced");
  });

  test("flips a source-less legacy managed balanced profile", () => {
    // Migration 052 seeded canonical profiles without a `source`; absent source
    // on this reserved name means legacy managed, so it must still be flipped.
    writeConfig({
      llm: {
        profiles: {
          balanced: {
            provider: "fireworks",
            model: "accounts/fireworks/models/minimax-m3",
          },
        },
      },
    });
    flipBalancedProfileToTogetherMigration.run(workspaceDir);
    const profile = readProfiles().balanced!;
    expect(profile.model).toBe("MiniMaxAI/MiniMax-M3");
    expect(profile.provider).toBe("together");
    expect(profile.provider_connection).toBe("together-managed");
  });

  test("leaves a user-owned balanced profile untouched", () => {
    const original = {
      llm: {
        profiles: {
          balanced: {
            source: "user",
            provider: "fireworks",
            model: "accounts/fireworks/models/minimax-m3",
          },
        },
      },
    };
    writeConfig(original);
    flipBalancedProfileToTogetherMigration.run(workspaceDir);
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
    flipBalancedProfileToTogetherMigration.run(workspaceDir);
    expect(readConfig()).toEqual(original);
  });

  test("idempotency: no-op on already-flipped config (no writes)", () => {
    writeConfig({
      llm: {
        profiles: {
          balanced: {
            source: "managed",
            provider: "together",
            provider_connection: "together-managed",
            model: "MiniMaxAI/MiniMax-M3",
          },
        },
      },
    });
    const beforeContent = readFileSync(
      join(workspaceDir, "config.json"),
      "utf-8",
    );
    flipBalancedProfileToTogetherMigration.run(workspaceDir);
    expect(readFileSync(join(workspaceDir, "config.json"), "utf-8")).toBe(
      beforeContent,
    );
  });
});
