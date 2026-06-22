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

import { removeAutoProfileMigration } from "../workspace/migrations/105-remove-auto-profile.js";

let workspaceDir: string;

function freshWorkspace(): void {
  workspaceDir = join(
    tmpdir(),
    `vellum-migration-105-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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
  delete process.env.VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH;
});

afterEach(() => {
  delete process.env.VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH;
  if (existsSync(workspaceDir)) {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

describe("105-remove-auto-profile migration", () => {
  test("has correct migration id", () => {
    expect(removeAutoProfileMigration.id).toBe("105-remove-auto-profile");
  });

  test("removes the auto profile and order entry from config.json", () => {
    writeConfig({
      llm: {
        activeProfile: "auto",
        profileOrder: ["auto", "balanced", "quality-optimized"],
        profiles: {
          auto: {
            source: "managed",
            label: "Auto",
          },
          balanced: {
            source: "managed",
            label: "Balanced",
          },
        },
      },
    });

    removeAutoProfileMigration.run(workspaceDir);

    expect(readConfig()).toEqual({
      llm: {
        activeProfile: "balanced",
        profileOrder: ["balanced", "quality-optimized"],
        profiles: {
          balanced: {
            source: "managed",
            label: "Balanced",
          },
        },
      },
    });
  });

  test("preserves an explicit non-auto active profile", () => {
    writeConfig({
      llm: {
        activeProfile: "quality-optimized",
        profileOrder: ["balanced", "auto", "quality-optimized"],
        profiles: {
          auto: { label: "Auto" },
          "quality-optimized": { label: "Quality" },
        },
      },
    });

    removeAutoProfileMigration.run(workspaceDir);

    const config = readConfig() as {
      llm: {
        activeProfile: string;
        profileOrder: string[];
        profiles: Record<string, unknown>;
      };
    };
    expect(config.llm.activeProfile).toBe("quality-optimized");
    expect(config.llm.profileOrder).toEqual(["balanced", "quality-optimized"]);
    expect(config.llm.profiles.auto).toBeUndefined();
  });

  test("is idempotent across repeated runs", () => {
    writeConfig({
      llm: {
        activeProfile: "auto",
        profileOrder: ["auto", "balanced"],
        profiles: { auto: {}, balanced: {} },
      },
    });

    removeAutoProfileMigration.run(workspaceDir);
    const afterFirst = readConfig();
    removeAutoProfileMigration.run(workspaceDir);

    expect(readConfig()).toEqual(afterFirst);
  });

  test("no-ops when config.json is missing or malformed", () => {
    removeAutoProfileMigration.run(workspaceDir);
    expect(existsSync(join(workspaceDir, "config.json"))).toBe(false);

    writeFileSync(join(workspaceDir, "config.json"), "{");
    removeAutoProfileMigration.run(workspaceDir);
    expect(readFileSync(join(workspaceDir, "config.json"), "utf-8")).toBe("{");
  });
});
