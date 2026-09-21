import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { moveTypesafeProfilesToClassificationMigration } from "../158-move-typesafe-profiles-to-classification.js";

function workspaceWith(config: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "typesafe-classification-migration-"));
  writeFileSync(join(dir, "config.json"), JSON.stringify(config, null, 2));
  return dir;
}

function seedConnections(
  dir: string,
  rows: Array<{ name: string; provider: string }>,
): void {
  mkdirSync(join(dir, "data", "db"), { recursive: true });
  const db = new Database(join(dir, "data", "db", "assistant.db"));
  db.exec(
    `CREATE TABLE provider_connections (name TEXT PRIMARY KEY, provider TEXT NOT NULL)`,
  );
  for (const row of rows) {
    db.prepare(`INSERT INTO provider_connections VALUES (?, ?)`).run(
      row.name,
      row.provider,
    );
  }
  db.close();
}

function readConfig(dir: string): any {
  return JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
}

const JEV = { provider: "typesafe", model: "jev-latest", source: "user" };
const BALANCED = { provider: "anthropic", model: "claude-opus-4-8" };
const FAST = { provider: "openai", model: "gpt-5.5" };

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

  test("recognizes a profile bound to a TypeSafe connection by entry name", () => {
    const dir = workspaceWith({
      llm: {
        profiles: {
          "jev-work": { provider: "jev-work", model: "jev-custom" },
          balanced: BALANCED,
        },
        callSites: { voiceEscalationJudge: { profile: "jev-work" } },
      },
    });
    seedConnections(dir, [
      { name: "jev-work", provider: "typesafe" },
      { name: "anthropic-personal", provider: "anthropic" },
    ]);

    moveTypesafeProfilesToClassificationMigration.run(dir);

    const config = readConfig(dir);
    expect(config.services.classification.model).toBe("jev-custom");
    expect(config.llm.profiles).toEqual({ balanced: BALANCED });
    expect(config.llm.callSites).toEqual({});
  });

  test("fails the run when the connection table cannot be read", () => {
    const dir = workspaceWith({ llm: { profiles: { jev: JEV } } });
    mkdirSync(join(dir, "data", "db"), { recursive: true });
    writeFileSync(join(dir, "data", "db", "assistant.db"), "not a database");

    expect(() =>
      moveTypesafeProfilesToClassificationMigration.run(dir),
    ).toThrow(/retrying/);
    expect(
      moveTypesafeProfilesToClassificationMigration.retryFailedCheckpoint,
    ).toBe(true);
  });

  test("keeps a mix with two or more surviving arms and clears top-level pointers", () => {
    const dir = workspaceWith({
      llm: {
        activeProfile: "jev",
        advisorProfile: "jev",
        profiles: {
          jev: JEV,
          balanced: BALANCED,
          fast: FAST,
          blend: {
            mix: [
              { profile: "jev", weight: 1 },
              { profile: "balanced", weight: 1 },
              { profile: "fast", weight: 2 },
            ],
          },
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
      mix: [
        { profile: "balanced", weight: 1 },
        { profile: "fast", weight: 2 },
      ],
    });
    expect(config.llm.callSites).toEqual({
      voiceFrontDoor: { profile: "balanced" },
    });
  });

  test("collapses a mix left with one arm onto that arm and rewrites its references", () => {
    const dir = workspaceWith({
      llm: {
        activeProfile: "blend",
        profiles: {
          jev: JEV,
          balanced: BALANCED,
          blend: {
            mix: [
              { profile: "jev", weight: 1 },
              { profile: "balanced", weight: 1 },
            ],
          },
          outer: {
            mix: [
              { profile: "blend", weight: 1 },
              { profile: "jev", weight: 1 },
            ],
          },
        },
        callSites: {
          mainAgent: { profile: "blend" },
          voiceFrontDoor: { mix: [{ profile: "outer" }, { profile: "jev" }] },
          advisor: { fallbackProfile: "outer", effort: "low" },
        },
      },
    });

    moveTypesafeProfilesToClassificationMigration.run(dir);

    const config = readConfig(dir);
    expect(config.llm.profiles).toEqual({ balanced: BALANCED });
    expect(config.llm.activeProfile).toBe("balanced");
    expect(config.llm.callSites).toEqual({
      mainAgent: { profile: "balanced" },
      voiceFrontDoor: { profile: "balanced" },
      advisor: { fallbackProfile: "balanced", effort: "low" },
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
