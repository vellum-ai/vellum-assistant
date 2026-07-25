import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
    // Temp-then-rename persistence leaves no temp file behind on success.
    expect(existsSync(configPath + ".tmp")).toBe(false);
  });

  // Root bypasses file permission checks, so chmod cannot make the workspace
  // read-only — skip rather than assert a failure path that cannot be
  // exercised.
  test.skipIf(process.getuid?.() === 0)(
    "throws on a write failure, leaving config.json byte-for-byte intact (retryable via failed checkpoint)",
    () => {
      write({ memory: { v2: { bm25_b: 0.6 } } });
      const before = readRaw();

      // A read-only workspace dir blocks creation of the config.json.tmp
      // staging file, standing in for any persistence failure.
      chmodSync(workspaceDir, 0o555);
      try {
        expect(() => MIG.run(workspaceDir)).toThrow();
      } finally {
        chmodSync(workspaceDir, 0o755);
      }

      // The failure surfaces to the runner (failed checkpoint, not completed)
      // and the migration opts into retrying that checkpoint on the next boot.
      expect(MIG.retryFailedCheckpoint).toBe(true);
      // config.json is untouched — the failed write targeted the temp file.
      expect(readRaw()).toBe(before);
      expect(existsSync(configPath + ".tmp")).toBe(false);

      // The retry succeeds once the workspace is writable again.
      MIG.run(workspaceDir);
      expect(memory().substrate).toEqual({ bm25_b: 0.6 });
    },
  );

  // Root bypasses file permission checks, so chmod 0o000 cannot make the
  // file unreadable — skip rather than assert a failure path that cannot be
  // exercised.
  test.skipIf(process.getuid?.() === 0)(
    "throws on a filesystem read failure so the failed checkpoint retries; malformed JSON stays a no-op",
    () => {
      write({ memory: { v2: { bm25_b: 0.6 } } });

      // An unreadable config.json is a transient fs failure, not malformed
      // content — it must surface to the runner instead of completing.
      chmodSync(configPath, 0o000);
      try {
        expect(() => MIG.run(workspaceDir)).toThrow();
      } finally {
        chmodSync(configPath, 0o644);
      }

      // The retry succeeds once the file is readable again.
      MIG.run(workspaceDir);
      expect(memory().substrate).toEqual({ bm25_b: 0.6 });
    },
  );

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

  test("skips loader-seeded values equal to the shipped defaults, including null-default keys", () => {
    // The config loader persists the fully-parsed config for normally-created
    // workspaces, so every defaulted v2 leaf is present in config.json. None
    // of these are user intent — the migration must not pin them into the
    // override-only substrate namespace.
    write({
      memory: {
        v2: {
          enabled: true,
          sweep_enabled: false,
          dense_weight: 0.85,
          sparse_weight: 0.15,
          bm25_k1: 1.2,
          bm25_b: 0.4,
          consolidation_interval_hours: 8,
          consolidation_max_buffer_lines: 100,
          consolidation_max_entries_per_run: 150,
          max_page_chars: 5000,
          consolidation_prompt_path: null,
          k: 0.5,
          hops: 2,
          ann_candidate_limit: null,
        },
      },
    });
    const before = readRaw();

    MIG.run(workspaceDir);

    // Nothing differs from a shipped default → no copy, no write at all.
    expect(readRaw()).toBe(before);
  });

  test("copies non-default values on nullable keys but skips their seeded null defaults", () => {
    write({
      memory: {
        v2: {
          ann_candidate_limit: 500,
          consolidation_prompt_path: null,
        },
      },
    });

    MIG.run(workspaceDir);

    // 500 differs from the shipped null default and copies; the seeded null
    // equals its default and stays out of the substrate namespace.
    expect(memory().substrate).toEqual({ ann_candidate_limit: 500 });
  });

  test("skips bm25_b values seeded by the earlier 0.75 default (multi-default key)", () => {
    write({
      memory: {
        v2: { bm25_b: 0.75, bm25_k1: 1.5 },
      },
    });

    MIG.run(workspaceDir);

    // 0.75 matches the pre-migration-075 shipped default and is seeded, not a
    // user override; the tuned bm25_k1 still copies.
    expect(memory().substrate).toEqual({ bm25_k1: 1.5 });
  });

  test("copies the no-default spread keys on presence alone", () => {
    // min_sparse_spread / full_sparse_spread ship with no schema default, so
    // the loader never seeds them — raw presence IS user intent.
    write({
      memory: {
        v2: { min_sparse_spread: 0.05, full_sparse_spread: 0.3 },
      },
    });

    MIG.run(workspaceDir);

    expect(memory().substrate).toEqual({
      min_sparse_spread: 0.05,
      full_sparse_spread: 0.3,
    });
  });

  test("a tuned weight pair copies whole and still parses after migration (resolved-pair weight check)", () => {
    // The v2 refinement validates dense_weight + sparse_weight on the
    // persisted values, so a valid config with a non-default dense_weight
    // necessarily persists its non-default twin — both copy, and the copied
    // substrate pair is exactly the pair v2 already accepted.
    write({ memory: { v2: { dense_weight: 0.9, sparse_weight: 0.1 } } });

    MIG.run(workspaceDir);

    expect(memory().substrate).toEqual({
      dense_weight: 0.9,
      sparse_weight: 0.1,
    });
    expect(() => MemoryConfigSchema.parse(memory())).not.toThrow();
  });

  test("is idempotent — a second run leaves the file byte-for-byte unchanged", () => {
    write({
      memory: {
        v2: { bm25_b: 0.6, k: 0.4, ann_candidate_limit: 500 },
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
      ann_candidate_limit: 500,
    });
  });

  test("down() is a forward-only no-op", () => {
    write({ memory: { v2: { bm25_b: 0.6 }, substrate: { bm25_b: 0.6 } } });
    const before = readRaw();

    expect(() => MIG.down(workspaceDir)).not.toThrow();

    expect(readRaw()).toBe(before);
  });
});
