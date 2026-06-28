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

import { memoryProviderMigration } from "../workspace/migrations/116-memory-provider.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let workspaceDir: string;

function freshWorkspace(): void {
  workspaceDir = join(
    tmpdir(),
    `vellum-migration-116-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

function provider(): unknown {
  return (readConfig().memory as Record<string, unknown>).provider;
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  freshWorkspace();
});

afterEach(() => {
  if (existsSync(workspaceDir)) {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("116-memory-provider migration", () => {
  test("has correct migration id and description", () => {
    expect(memoryProviderMigration.id).toBe("116-memory-provider");
    expect(memoryProviderMigration.description).toBe(
      "Pin memory.provider from legacy memory.v2.enabled / memory.v3.live gates",
    );
  });

  // ─── Legacy mapping ─────────────────────────────────────────────────────

  test("maps v3.live=true to provider 'v3'", () => {
    writeConfig({ memory: { v2: { enabled: true }, v3: { live: true } } });
    memoryProviderMigration.run(workspaceDir);
    expect(provider()).toBe("v3");
  });

  test("v3.live wins over v2.enabled", () => {
    writeConfig({ memory: { v2: { enabled: false }, v3: { live: true } } });
    memoryProviderMigration.run(workspaceDir);
    expect(provider()).toBe("v3");
  });

  test("maps v2.enabled=true (v3 not live) to provider 'v2'", () => {
    writeConfig({ memory: { v2: { enabled: true }, v3: { live: false } } });
    memoryProviderMigration.run(workspaceDir);
    expect(provider()).toBe("v2");
  });

  test("maps explicit v2.enabled=false (v3 not live) to provider 'graph'", () => {
    writeConfig({ memory: { v2: { enabled: false }, v3: { live: false } } });
    memoryProviderMigration.run(workspaceDir);
    expect(provider()).toBe("graph");
  });

  test("maps missing v2/v3 entirely to provider 'v2' (schema default)", () => {
    // An empty `memory` object sets no explicit `v2.enabled`, which defaults to
    // `true` in MemoryV2ConfigSchema — so the pre-migration runtime ran v2.
    writeConfig({ memory: {} });
    memoryProviderMigration.run(workspaceDir);
    expect(provider()).toBe("v2");
  });

  test("memory present without v2.enabled derives 'v2' (schema default, not graph)", () => {
    // An existing `memory` object that carries unrelated keys but omits
    // `v2.enabled` (raw JSON has `v2.enabled === undefined`) ran v2 before the
    // migration, because the schema defaults it to `true`. The migration must
    // not silently switch such an upgraded workspace to graph.
    writeConfig({ memory: { embeddings: { provider: "google" } } });
    memoryProviderMigration.run(workspaceDir);
    expect(provider()).toBe("v2");
  });

  test("v2 object present without enabled key derives 'v2' (schema default)", () => {
    // `v2` exists as an object but omits `enabled` — still the schema default
    // (true), so it derives v2, not graph.
    writeConfig({ memory: { v2: { sweep_enabled: true } } });
    memoryProviderMigration.run(workspaceDir);
    expect(provider()).toBe("v2");
  });

  test("absent provider key with auto-equivalent legacy state derives provider", () => {
    writeConfig({ memory: { v3: { live: true } } });
    memoryProviderMigration.run(workspaceDir);
    expect(provider()).toBe("v3");
  });

  test("explicit provider 'auto' is treated as derivable", () => {
    writeConfig({ memory: { provider: "auto", v2: { enabled: true } } });
    memoryProviderMigration.run(workspaceDir);
    expect(provider()).toBe("v2");
  });

  // ─── Already-explicit provider is untouched ─────────────────────────────

  test("leaves an explicit non-auto provider untouched (v3)", () => {
    writeConfig({ memory: { provider: "v3", v2: { enabled: true } } });
    memoryProviderMigration.run(workspaceDir);
    expect(provider()).toBe("v3");
  });

  test("leaves an explicit 'none' provider untouched", () => {
    writeConfig({ memory: { provider: "none", v3: { live: true } } });
    memoryProviderMigration.run(workspaceDir);
    expect(provider()).toBe("none");
  });

  test("does not rewrite the file when provider is already explicit", () => {
    writeConfig({ memory: { provider: "graph", v3: { live: true } } });
    const before = readFileSync(join(workspaceDir, "config.json"), "utf-8");
    memoryProviderMigration.run(workspaceDir);
    const after = readFileSync(join(workspaceDir, "config.json"), "utf-8");
    expect(after).toBe(before);
  });

  // ─── Idempotency ────────────────────────────────────────────────────────

  test("idempotency: re-running after derivation is a no-op", () => {
    writeConfig({ memory: { v2: { enabled: true } } });

    memoryProviderMigration.run(workspaceDir);
    const afterFirst = readConfig();
    expect((afterFirst.memory as Record<string, unknown>).provider).toBe("v2");

    memoryProviderMigration.run(workspaceDir);
    const afterSecond = readConfig();

    expect(afterSecond).toEqual(afterFirst);
  });

  // ─── Preserves siblings & legacy keys ───────────────────────────────────

  test("retains legacy keys and other config after derivation", () => {
    writeConfig({
      memory: { enabled: true, v2: { enabled: true }, v3: { live: false } },
      llm: { default: { provider: "anthropic" } },
    });
    memoryProviderMigration.run(workspaceDir);
    const config = readConfig();
    const memory = config.memory as Record<string, unknown>;
    expect(memory.provider).toBe("v2");
    expect(memory.enabled).toBe(true);
    expect((memory.v2 as Record<string, unknown>).enabled).toBe(true);
    expect((memory.v3 as Record<string, unknown>).live).toBe(false);
    expect(config.llm).toEqual({ default: { provider: "anthropic" } });
  });

  // ─── Graceful no-ops ────────────────────────────────────────────────────

  test("no-op when config.json does not exist", () => {
    memoryProviderMigration.run(workspaceDir);
    expect(existsSync(join(workspaceDir, "config.json"))).toBe(false);
  });

  test("no-op when config has no memory key", () => {
    const original = { llm: { default: { provider: "anthropic" } } };
    writeConfig(original);
    memoryProviderMigration.run(workspaceDir);
    expect(readConfig()).toEqual(original);
  });

  test("gracefully handles invalid JSON", () => {
    writeFileSync(join(workspaceDir, "config.json"), "not-valid-json");
    memoryProviderMigration.run(workspaceDir);
    expect(readFileSync(join(workspaceDir, "config.json"), "utf-8")).toBe(
      "not-valid-json",
    );
  });

  test("gracefully handles array-shaped config", () => {
    writeFileSync(join(workspaceDir, "config.json"), JSON.stringify([1, 2, 3]));
    memoryProviderMigration.run(workspaceDir);
    const raw = JSON.parse(
      readFileSync(join(workspaceDir, "config.json"), "utf-8"),
    );
    expect(raw).toEqual([1, 2, 3]);
  });

  test("gracefully handles non-object memory value", () => {
    writeConfig({ memory: 42, other: true });
    memoryProviderMigration.run(workspaceDir);
    expect(readConfig()).toEqual({ memory: 42, other: true });
  });
});
