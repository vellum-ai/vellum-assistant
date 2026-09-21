import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { moveTypesafeProfilesToClassificationMigration } from "../158-move-typesafe-profiles-to-classification.js";

function workspaceWith(config: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "typesafe-classification-migration-"));
  writeFileSync(join(dir, "config.json"), JSON.stringify(config, null, 2));
  return dir;
}

function readConfig(dir: string): any {
  return JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
}

const JEV = { provider: "typesafe", model: "jev-latest", source: "user" };
const BALANCED = { provider: "anthropic", model: "claude-opus-4-8" };

describe("158-move-typesafe-profiles-to-classification", () => {
  test("moves a TypeSafe profile into services.classification and unpins its call sites", () => {
    const dir = workspaceWith({
      llm: {
        profiles: { jev: JEV, balanced: BALANCED },
        callSites: {
          voiceEscalationJudge: { profile: "jev" },
          voiceContinuationJudge: { profile: "jev", effort: "low" },
          mainAgent: { profile: "balanced" },
        },
      },
    });

    moveTypesafeProfilesToClassificationMigration.run(dir);

    const config = readConfig(dir);
    expect(config.services.classification).toEqual({
      mode: "your-own",
      provider: "typesafe",
      model: "jev-latest",
    });
    expect(config.llm.profiles).toEqual({ balanced: BALANCED });
    expect(config.llm.callSites).toEqual({
      voiceContinuationJudge: { effort: "low" },
      mainAgent: { profile: "balanced" },
    });
  });

  test("clears mix arms, fallback pointers, and the active profile that named it", () => {
    const dir = workspaceWith({
      llm: {
        activeProfile: "jev",
        advisorProfile: "jev",
        profiles: {
          jev: JEV,
          balanced: BALANCED,
          blend: { mix: [{ profile: "jev" }, { profile: "balanced" }] },
        },
        callSites: {
          memoryV3SelectL2: { mix: [{ profile: "jev" }] },
          voiceFrontDoor: { profile: "balanced", fallbackProfile: "jev" },
        },
      },
    });

    moveTypesafeProfilesToClassificationMigration.run(dir);

    const config = readConfig(dir);
    expect(config.llm.activeProfile).toBeUndefined();
    expect(config.llm.advisorProfile).toBeUndefined();
    expect(config.llm.profiles.blend).toEqual({
      mix: [{ profile: "balanced" }],
    });
    expect(config.llm.callSites).toEqual({
      voiceFrontDoor: { profile: "balanced" },
    });
  });

  test("keeps an existing services.classification block", () => {
    const dir = workspaceWith({
      services: {
        classification: {
          mode: "managed",
          provider: "typesafe",
          model: "jev-latest",
        },
      },
      llm: { profiles: { jev: { ...JEV, model: "jev-2026" } } },
    });

    moveTypesafeProfilesToClassificationMigration.run(dir);

    expect(readConfig(dir).services.classification.mode).toBe("managed");
    expect(readConfig(dir).llm.profiles).toEqual({});
  });

  test("is a no-op without a TypeSafe profile", () => {
    const original = {
      llm: { profiles: { balanced: BALANCED }, callSites: {} },
    };
    const dir = workspaceWith(original);

    moveTypesafeProfilesToClassificationMigration.run(dir);
    moveTypesafeProfilesToClassificationMigration.run(dir);

    expect(readConfig(dir)).toEqual(original);
  });
});
