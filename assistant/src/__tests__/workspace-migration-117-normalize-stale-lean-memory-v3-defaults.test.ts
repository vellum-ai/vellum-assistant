/**
 * Tests for workspace migration `117-normalize-stale-lean-memory-v3-defaults`.
 *
 * The first-launch seed persists the fully-defaulted config.json, so assistants
 * created during the lean-default window stored the lean v3 tuning values as if
 * explicit. The migration strips persisted v3 tuning leaves that equal the
 * retired lean defaults so the restored full schema defaults re-apply, while
 * preserving deliberate (non-lean) values, pre-lean full values, and untouched
 * sibling fields. It never creates config.json and is idempotent.
 */

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { MemoryV3ConfigSchema } from "../config/schemas/memory-v3.js";
import { normalizeStaleLeanMemoryV3DefaultsMigration } from "../workspace/migrations/117-normalize-stale-lean-memory-v3-defaults.js";

let workspaceDir: string;
let configPath: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "vellum-migration-117-test-"));
  configPath = join(workspaceDir, "config.json");
});

afterEach(() => {
  if (existsSync(workspaceDir)) {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

function readConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(configPath, "utf-8"));
}

/** A config.json as the first-launch seed would persist it on the lean build:
 *  the full v3 block with every tuning value at its lean default. */
function leanSeedConfig(): Record<string, unknown> {
  return {
    memory: {
      v3: {
        live: true,
        prune: { maxResidentBytes: 393216, targetResidentBytes: 262144 },
        hotSet: { k: 8, halfLifeDays: 14 },
        freshSet: { k: 8 },
        learnedEdges: {
          halfLifeDays: 30,
          minCount: 3,
          npmiFloor: 0.2,
          maxPerPage: 6,
          perSeed: 3,
          cap: 0,
        },
        spotlight: { n: 6, windowTurns: 2 },
        needleK: 12,
        denseK: 0,
        replyQueryK: 0,
        selectorEnabled: false,
        selectorPromptPath: null,
        edge: { hubDegree: 30, seedCount: 6, perSeed: 1, cap: 6 },
      },
    },
  };
}

describe("117-normalize-stale-lean-memory-v3-defaults migration", () => {
  test("has correct id and description", () => {
    expect(normalizeStaleLeanMemoryV3DefaultsMigration.id).toBe(
      "117-normalize-stale-lean-memory-v3-defaults",
    );
    expect(normalizeStaleLeanMemoryV3DefaultsMigration.description).toContain(
      "memory.v3",
    );
  });

  test("strips lean tuning leaves so the full schema defaults re-apply", () => {
    writeFileSync(configPath, JSON.stringify(leanSeedConfig()), "utf-8");

    normalizeStaleLeanMemoryV3DefaultsMigration.run(workspaceDir);

    const v3 = (readConfig().memory as Record<string, unknown>).v3 as Record<
      string,
      unknown
    >;
    // The switched leaves are gone…
    expect("needleK" in v3).toBe(false);
    expect("denseK" in v3).toBe(false);
    expect("replyQueryK" in v3).toBe(false);
    expect("selectorEnabled" in v3).toBe(false);
    expect("k" in (v3.hotSet as Record<string, unknown>)).toBe(false);
    expect("k" in (v3.freshSet as Record<string, unknown>)).toBe(false);
    expect("cap" in (v3.learnedEdges as Record<string, unknown>)).toBe(false);
    const edge = v3.edge as Record<string, unknown>;
    expect("seedCount" in edge).toBe(false);
    expect("perSeed" in edge).toBe(false);
    expect("cap" in edge).toBe(false);

    // …untouched siblings survive…
    expect(v3.live).toBe(true);
    expect((v3.hotSet as Record<string, unknown>).halfLifeDays).toBe(14);
    expect(edge.hubDegree).toBe(30);
    expect((v3.learnedEdges as Record<string, unknown>).perSeed).toBe(3);

    // …and re-parsing yields the restored full profile.
    const parsed = MemoryV3ConfigSchema.parse(v3);
    expect(parsed.needleK).toBe(100);
    expect(parsed.denseK).toBe(100);
    expect(parsed.replyQueryK).toBe(12);
    expect(parsed.selectorEnabled).toBe(true);
    expect(parsed.hotSet.k).toBe(40);
    expect(parsed.freshSet.k).toBe(100);
    expect(parsed.learnedEdges.cap).toBe(20);
    expect(parsed.edge).toEqual({
      hubDegree: 30,
      seedCount: 18,
      perSeed: 6,
      cap: 45,
    });
  });

  test("leaves a config with any non-lean tuning untouched (not the lean-seed signature)", () => {
    // A lean-seed config the user later edited one field of no longer matches
    // the all-lean signature, so the migration leaves it alone rather than
    // partially rewriting an explicit config.
    const config = leanSeedConfig();
    (
      (config.memory as Record<string, unknown>).v3 as Record<string, unknown>
    ).needleK = 50;
    const original = JSON.stringify(config);
    writeFileSync(configPath, original, "utf-8");

    normalizeStaleLeanMemoryV3DefaultsMigration.run(workspaceDir);

    expect(readFileSync(configPath, "utf-8")).toBe(original);
  });

  test("preserves a deliberate lean-valued override (partial config, not a full seed)", () => {
    // An established assistant that deliberately disables dense retrieval must
    // keep that choice — a lone lean-valued leaf is not the seed signature.
    const original = JSON.stringify({ memory: { v3: { denseK: 0 } } });
    writeFileSync(configPath, original, "utf-8");

    normalizeStaleLeanMemoryV3DefaultsMigration.run(workspaceDir);

    expect(readFileSync(configPath, "utf-8")).toBe(original);
  });

  test("leaves a pre-lean full config untouched (no write)", () => {
    const fullConfig = {
      memory: {
        v3: {
          needleK: 100,
          denseK: 100,
          replyQueryK: 12,
          selectorEnabled: true,
          hotSet: { k: 40, halfLifeDays: 14 },
          freshSet: { k: 100 },
          learnedEdges: { cap: 20, maxPerPage: 6 },
          edge: { hubDegree: 30, seedCount: 18, perSeed: 6, cap: 45 },
        },
      },
    };
    const original = JSON.stringify(fullConfig);
    writeFileSync(configPath, original, "utf-8");

    normalizeStaleLeanMemoryV3DefaultsMigration.run(workspaceDir);

    expect(readFileSync(configPath, "utf-8")).toBe(original);
  });

  test("no-op when config.json is absent (never creates it)", () => {
    normalizeStaleLeanMemoryV3DefaultsMigration.run(workspaceDir);
    expect(existsSync(configPath)).toBe(false);
  });

  test("no-op when there is no memory.v3 block", () => {
    const original = JSON.stringify({ memory: { enabled: true } });
    writeFileSync(configPath, original, "utf-8");

    normalizeStaleLeanMemoryV3DefaultsMigration.run(workspaceDir);

    expect(readFileSync(configPath, "utf-8")).toBe(original);
  });

  test("leaves malformed config.json untouched", () => {
    writeFileSync(configPath, "{ not json", "utf-8");

    normalizeStaleLeanMemoryV3DefaultsMigration.run(workspaceDir);

    expect(readFileSync(configPath, "utf-8")).toBe("{ not json");
  });

  test("is idempotent", () => {
    writeFileSync(configPath, JSON.stringify(leanSeedConfig()), "utf-8");

    normalizeStaleLeanMemoryV3DefaultsMigration.run(workspaceDir);
    const afterFirst = readFileSync(configPath, "utf-8");

    normalizeStaleLeanMemoryV3DefaultsMigration.run(workspaceDir);

    expect(readFileSync(configPath, "utf-8")).toBe(afterFirst);
  });

  test("down is a no-op", () => {
    writeFileSync(configPath, JSON.stringify(leanSeedConfig()), "utf-8");
    normalizeStaleLeanMemoryV3DefaultsMigration.run(workspaceDir);
    const before = readFileSync(configPath, "utf-8");

    normalizeStaleLeanMemoryV3DefaultsMigration.down(workspaceDir);

    expect(readFileSync(configPath, "utf-8")).toBe(before);
  });
});
