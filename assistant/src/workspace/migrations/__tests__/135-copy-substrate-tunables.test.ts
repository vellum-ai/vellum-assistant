import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { MemoryConfigSchema } from "../../../config/schemas/memory.js";
import { copySubstrateTunablesMigration as MIG } from "../135-copy-substrate-tunables.js";

let workspaceDir: string;
let configPath: string;

function write(obj: unknown): void {
  writeFileSync(configPath, JSON.stringify(obj, null, 2) + "\n");
}
function readRaw(): string {
  return readFileSync(configPath, "utf-8");
}
function read(): Record<string, unknown> {
  return JSON.parse(readRaw());
}
function memory(): Record<string, unknown> {
  return read().memory as Record<string, unknown>;
}

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "copy-substrate-tunables-"));
  configPath = join(workspaceDir, "config.json");
});
afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
});

describe("135-copy-substrate-tunables", () => {
  test("has the expected id", () => {
    expect(MIG.id).toBe("135-copy-substrate-tunables");
  });

  test("no-ops when config.json is absent, unparseable, or has no memory config", () => {
    // Absent config.json.
    expect(() => MIG.run(workspaceDir)).not.toThrow();

    // Unparseable config.json is left byte-for-byte alone.
    writeFileSync(configPath, "{not json");
    MIG.run(workspaceDir);
    expect(readRaw()).toBe("{not json");

    // No memory config — fresh-workspace shape.
    write({ llm: { provider: "anthropic" } });
    const before = readRaw();
    MIG.run(workspaceDir);
    expect(readRaw()).toBe(before);

    // memory present but no v2 subtree.
    write({ memory: { enabled: true } });
    const beforeNoV2 = readRaw();
    MIG.run(workspaceDir);
    expect(readRaw()).toBe(beforeNoV2);
  });

  test("never introduces memory.substrate when memory.v2 sets no substrate tunables", () => {
    write({ memory: { v2: { enabled: true, hybrid_min_score: 0.02 } } });
    const before = readRaw();

    MIG.run(workspaceDir);

    // Nothing copied → no write at all, so no empty substrate object appears.
    expect(readRaw()).toBe(before);
  });

  test("copies an explicit memory.v2.consolidation_interval_hours, leaving memory.v2 untouched", () => {
    write({
      memory: {
        v2: { enabled: true, consolidation_interval_hours: 6 },
      },
    });

    MIG.run(workspaceDir);

    expect(memory()).toEqual({
      v2: { enabled: true, consolidation_interval_hours: 6 },
      substrate: { consolidation_interval_hours: 6 },
    });
  });

  test("renames k→spread_k and hops→spread_hops; a tuned bm25_b lands on the substrate key (v2-fallback removal safe)", () => {
    write({
      memory: {
        v2: { k: 0.4, hops: 3, bm25_b: 0.6 },
      },
    });

    MIG.run(workspaceDir);

    const substrate = memory().substrate as Record<string, unknown>;
    // The substrate namespace now carries the tuned values itself: resolving
    // WITHOUT the resolver's substrate→v2 fallback yields the same behavior.
    expect(substrate).toEqual({ spread_k: 0.4, spread_hops: 3, bm25_b: 0.6 });
    expect(memory().v2).toEqual({ k: 0.4, hops: 3, bm25_b: 0.6 });
  });

  test("never clobbers an already-set memory.substrate key, but still copies its unset siblings", () => {
    write({
      memory: {
        v2: { bm25_b: 0.6, max_page_chars: 9000 },
        substrate: { bm25_b: 0.3 },
      },
    });

    MIG.run(workspaceDir);

    expect(memory().substrate).toEqual({ bm25_b: 0.3, max_page_chars: 9000 });
    expect(memory().v2).toEqual({ bm25_b: 0.6, max_page_chars: 9000 });
  });

  test("copies explicit nulls on nullable keys (explicit substrate null counts as set)", () => {
    write({
      memory: {
        v2: { ann_candidate_limit: null, consolidation_prompt_path: null },
      },
    });

    MIG.run(workspaceDir);

    expect(memory().substrate).toEqual({
      ann_candidate_limit: null,
      consolidation_prompt_path: null,
    });
  });

  test("a lone explicit memory.v2.dense_weight still parses after migration (resolved-pair weight check)", () => {
    // 0.85 is valid against v2's default sparse_weight 0.15; after migration
    // the lone substrate dense_weight resolves against the SAME v2 fallback
    // pair, so the parent schema's resolved-pair check must still accept it.
    write({ memory: { v2: { dense_weight: 0.85 } } });

    MIG.run(workspaceDir);

    expect(memory().substrate).toEqual({ dense_weight: 0.85 });
    expect(() => MemoryConfigSchema.parse(memory())).not.toThrow();
  });

  test("is idempotent — a second run leaves the file byte-for-byte unchanged", () => {
    write({
      memory: {
        v2: { bm25_b: 0.6, k: 0.4, ann_candidate_limit: null },
        substrate: { sweep_enabled: true },
      },
    });

    MIG.run(workspaceDir);
    const afterFirst = readRaw();
    MIG.run(workspaceDir);

    expect(readRaw()).toBe(afterFirst);
    expect(memory().substrate).toEqual({
      sweep_enabled: true,
      bm25_b: 0.6,
      spread_k: 0.4,
      ann_candidate_limit: null,
    });
  });

  test("down() is a forward-only no-op", () => {
    write({ memory: { v2: { bm25_b: 0.6 }, substrate: { bm25_b: 0.6 } } });
    const before = readRaw();

    expect(() => MIG.down(workspaceDir)).not.toThrow();

    expect(readRaw()).toBe(before);
  });
});
