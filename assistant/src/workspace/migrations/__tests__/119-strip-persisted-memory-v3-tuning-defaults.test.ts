import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { stripPersistedMemoryV3TuningDefaultsMigration as MIG } from "../119-strip-persisted-memory-v3-tuning-defaults.js";

let workspaceDir: string;
let configPath: string;

function write(obj: unknown): void {
  writeFileSync(configPath, JSON.stringify(obj, null, 2) + "\n");
}
function read(): Record<string, unknown> {
  return JSON.parse(readFileSync(configPath, "utf-8"));
}
function v3(): Record<string, unknown> {
  return (read().memory as { v3: Record<string, unknown> }).v3;
}

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "strip-v3-tuning-"));
  mkdirSync(workspaceDir, { recursive: true });
  configPath = join(workspaceDir, "config.json");
});
afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
});

describe("119-strip-persisted-memory-v3-tuning-defaults", () => {
  test("has the expected id", () => {
    expect(MIG.id).toBe("119-strip-persisted-memory-v3-tuning-defaults");
  });

  test("strips retired lean-profile defaults left by a mixed lean-era config", () => {
    // A lean-seeded config that migration 117 skipped (one leaf later edited to
    // a non-lean value), so the remaining lean defaults are still pinned here.
    write({
      memory: {
        v3: {
          live: true,
          needleK: 12, // lean -> stripped
          denseK: 0, // lean -> stripped
          replyQueryK: 0, // lean -> stripped
          selectorEnabled: false, // lean -> stripped
          hotSet: { k: 20 }, // deliberate edit (broke 117's signature) -> kept
          edge: { seedCount: 6, perSeed: 1, cap: 6 }, // lean -> stripped (edge emptied)
        },
      },
    });

    MIG.run(workspaceDir);

    expect(v3()).toEqual({ live: true, hotSet: { k: 20 } });
  });

  test("strips a fully-defaulted memory.v3 block, keeping only live", () => {
    write({
      memory: {
        v3: {
          live: true,
          needleK: 100,
          denseK: 100,
          replyQueryK: 12,
          selectorEnabled: true,
          selectorPromptPath: null,
          prune: { maxResidentBytes: 393216, targetResidentBytes: 262144 },
          hotSet: { k: 40, halfLifeDays: 14 },
          freshSet: { k: 100 },
          learnedEdges: {
            halfLifeDays: 30,
            minCount: 3,
            npmiFloor: 0.2,
            maxPerPage: 6,
            perSeed: 3,
            cap: 20,
          },
          spotlight: { n: 6, windowTurns: 2 },
          edge: { hubDegree: 30, seedCount: 18, perSeed: 6, cap: 45 },
          entity: { enabled: true, idfFloor: 4, cap: 8 },
          gate: {
            denseThreshold: 0.66,
            sparseThreshold: 0.35,
            sparseOnlyThreshold: 0.75,
            denseClusterThreshold: 0.6,
            denseClusterMaxDelta: 0.02,
            topK: 5,
            bm25NormK: null,
            bypassForCore: false,
          },
        },
      },
    });

    MIG.run(workspaceDir);

    expect(v3()).toEqual({ live: true });
  });

  test("strips superseded gate-threshold defaults too (0.62, 0.52, 0.47, 0.04, 0.45)", () => {
    write({
      memory: {
        v3: {
          live: false,
          gate: {
            denseThreshold: 0.52,
            sparseOnlyThreshold: 0.62,
            denseClusterThreshold: 0.47,
            denseClusterMaxDelta: 0.04,
          },
        },
      },
    });

    MIG.run(workspaceDir);

    // Whole gate block was superseded defaults → dropped; live preserved.
    expect(v3()).toEqual({ live: false });
  });

  test("preserves deliberate non-default overrides, strips defaulted siblings", () => {
    write({
      memory: {
        v3: {
          live: true,
          denseK: 100, // default -> stripped
          needleK: 50, // override -> kept
          gate: {
            denseThreshold: 0.7, // override -> kept
            sparseOnlyThreshold: 0.62, // superseded default -> stripped
          },
        },
      },
    });

    MIG.run(workspaceDir);

    expect(v3()).toEqual({
      live: true,
      needleK: 50,
      gate: { denseThreshold: 0.7 },
    });
  });

  test("never touches memory.v3.live or unknown keys", () => {
    write({
      memory: { v3: { live: true, someFutureKnob: "x", needleK: 100 } },
    });

    MIG.run(workspaceDir);

    expect(v3()).toEqual({ live: true, someFutureKnob: "x" });
  });

  test("no-ops cleanly when config.json / memory / v3 is absent or non-default-free", () => {
    // absent config.json
    expect(() => MIG.run(workspaceDir)).not.toThrow();

    // no memory.v3
    write({ memory: { enabled: true } });
    MIG.run(workspaceDir);
    expect(read()).toEqual({ memory: { enabled: true } });

    // v3 with only overrides + live -> unchanged (no write needed)
    write({ memory: { v3: { live: true, denseK: 7 } } });
    MIG.run(workspaceDir);
    expect(v3()).toEqual({ live: true, denseK: 7 });
  });

  test("down() is a forward-only no-op", () => {
    write({ memory: { v3: { live: true } } });
    expect(() => MIG.down?.(workspaceDir)).not.toThrow();
    expect(v3()).toEqual({ live: true });
  });
});
