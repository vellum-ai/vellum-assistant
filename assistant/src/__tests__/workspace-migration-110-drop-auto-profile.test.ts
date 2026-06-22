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

import { dropAutoProfileMigration } from "../workspace/migrations/110-drop-auto-profile.js";

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

function configPath(): string {
  return join(workspaceDir, "config.json");
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

describe("110-drop-auto-profile migration", () => {
  test("has correct migration id", () => {
    expect(dropAutoProfileMigration.id).toBe("110-drop-auto-profile");
  });

  test("no-op when config.json does not exist", () => {
    dropAutoProfileMigration.run(workspaceDir);
    expect(existsSync(configPath())).toBe(false);
  });

  test("gracefully handles invalid JSON", () => {
    writeFileSync(configPath(), "not-valid-json");
    dropAutoProfileMigration.run(workspaceDir);
    expect(readFileSync(configPath(), "utf-8")).toBe("not-valid-json");
  });

  test("removes auto profile and prunes profileOrder", () => {
    writeConfig({
      llm: {
        profiles: {
          auto: { source: "managed", label: "Auto" },
          balanced: { source: "managed", label: "Balanced" },
        },
        profileOrder: ["auto", "balanced"],
        activeProfile: "balanced",
      },
    });

    dropAutoProfileMigration.run(workspaceDir);

    const llm = readLlm() as {
      profiles: Record<string, unknown>;
      profileOrder: string[];
    };
    expect(llm.profiles.auto).toBeUndefined();
    expect(llm.profileOrder).toEqual(["balanced"]);
  });

  test("repoints active, advisor, call-site, and mix references to balanced", () => {
    writeConfig({
      llm: {
        profiles: {
          auto: { source: "managed", label: "Auto" },
          balanced: { source: "managed", label: "Balanced" },
          mix: {
            source: "user",
            mix: [
              { profile: "auto", weight: 1 },
              { profile: "quality-optimized", weight: 1 },
            ],
          },
        },
        profileOrder: ["auto", "balanced", "mix"],
        activeProfile: "auto",
        advisorProfile: "auto",
        callSites: {
          mainAgent: { profile: "auto" },
          memoryRouter: { profile: "cost-optimized" },
        },
      },
    });

    dropAutoProfileMigration.run(workspaceDir);

    const llm = readLlm() as {
      activeProfile: string;
      advisorProfile: string;
      callSites: Record<string, Record<string, unknown>>;
      profiles: Record<string, { mix?: Array<Record<string, unknown>> }>;
    };
    expect(llm.activeProfile).toBe("balanced");
    expect(llm.advisorProfile).toBe("balanced");
    expect(llm.callSites.mainAgent?.profile).toBe("balanced");
    expect(llm.callSites.memoryRouter?.profile).toBe("cost-optimized");
    expect(llm.profiles.mix?.mix?.map((arm) => arm.profile)).toEqual([
      "balanced",
      "quality-optimized",
    ]);
  });

  test("re-enables balanced when it becomes active", () => {
    writeConfig({
      llm: {
        profiles: {
          auto: { source: "managed", label: "Auto" },
          balanced: {
            source: "managed",
            label: "Balanced",
            status: "disabled",
          },
        },
        activeProfile: "auto",
      },
    });

    dropAutoProfileMigration.run(workspaceDir);

    const llm = readLlm() as {
      activeProfile: string;
      profiles: Record<string, Record<string, unknown>>;
    };
    expect(llm.activeProfile).toBe("balanced");
    expect(llm.profiles.balanced?.status).toBeUndefined();
  });

  test("deletes references when balanced is unavailable", () => {
    writeConfig({
      llm: {
        profiles: {
          auto: { source: "managed", label: "Auto" },
          custom: { source: "user", mix: [{ profile: "auto", weight: 1 }] },
        },
        activeProfile: "auto",
        advisorProfile: "auto",
        callSites: { mainAgent: { profile: "auto", effort: "low" } },
      },
    });

    dropAutoProfileMigration.run(workspaceDir);

    const llm = readLlm() as {
      activeProfile?: string;
      advisorProfile?: string;
      callSites: Record<string, Record<string, unknown>>;
      profiles: Record<string, Record<string, unknown>>;
    };
    expect(llm.activeProfile).toBeUndefined();
    expect(llm.advisorProfile).toBeUndefined();
    expect(llm.callSites.mainAgent?.profile).toBeUndefined();
    expect(llm.callSites.mainAgent?.effort).toBe("low");
    expect(llm.profiles.custom?.mix).toBeUndefined();
  });

  test("idempotency: no-op once auto is gone", () => {
    writeConfig({
      llm: {
        profiles: { balanced: { source: "managed", label: "Balanced" } },
        profileOrder: ["balanced"],
        activeProfile: "balanced",
      },
    });
    const before = readFileSync(configPath(), "utf-8");

    dropAutoProfileMigration.run(workspaceDir);

    expect(readFileSync(configPath(), "utf-8")).toBe(before);
  });
});
