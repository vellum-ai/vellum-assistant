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

import { collapseBuiltinProfilesToOverridesMigration } from "../workspace/migrations/098-collapse-builtin-profiles-to-overrides.js";

let workspaceDir: string;

function freshWorkspace(): void {
  workspaceDir = join(
    tmpdir(),
    `vellum-migration-098-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

function readLlm(): Record<string, unknown> {
  return readConfig().llm as Record<string, unknown>;
}

beforeEach(() => {
  freshWorkspace();
});

afterEach(() => {
  if (existsSync(workspaceDir)) {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

describe("098-collapse-builtin-profiles-to-overrides migration", () => {
  test("has correct migration id", () => {
    expect(collapseBuiltinProfilesToOverridesMigration.id).toBe(
      "098-collapse-builtin-profiles-to-overrides",
    );
  });

  test("drifted entry: custom label + disabled status lift into overrides, entry deleted, drifted model dropped", () => {
    writeConfig({
      llm: {
        profiles: {
          balanced: {
            provider: "anthropic",
            provider_connection: "anthropic-managed",
            model: "claude-assistant-modified-model",
            maxTokens: 999,
            effort: "high",
            thinking: { enabled: true, streamThinking: true },
            source: "managed",
            label: "My Balanced",
            status: "disabled",
          },
        },
        activeProfile: "balanced",
      },
    });

    collapseBuiltinProfilesToOverridesMigration.run(workspaceDir);

    const llm = readLlm();
    const profiles = llm.profiles as Record<string, unknown>;
    const overrides = llm.profileOverrides as Record<
      string,
      Record<string, unknown>
    >;
    expect("balanced" in profiles).toBe(false);
    expect(overrides.balanced).toEqual({
      label: "My Balanced",
      status: "disabled",
    });
    // Drift is dropped, not preserved anywhere.
    expect(JSON.stringify(readConfig())).not.toContain(
      "claude-assistant-modified-model",
    );
  });

  test("collapses every built-in name, including auto and balanced-economy", () => {
    writeConfig({
      llm: {
        profiles: {
          auto: { source: "managed", label: "Auto" },
          balanced: { source: "managed", label: "Balanced" },
          "quality-optimized": { source: "managed", label: "Quality" },
          "cost-optimized": { source: "managed", label: "Speed" },
          "balanced-economy": {
            source: "managed",
            label: "Balanced Economy",
          },
        },
      },
    });

    collapseBuiltinProfilesToOverridesMigration.run(workspaceDir);

    const llm = readLlm();
    expect(llm.profiles).toEqual({});
    // All labels were seed defaults — nothing to lift, no override store.
    expect(llm.profileOverrides).toBeUndefined();
  });

  test("seed-default bare labels are NOT lifted", () => {
    writeConfig({
      llm: {
        profiles: {
          balanced: { source: "managed", label: "Balanced" },
          "cost-optimized": {
            source: "managed",
            label: "Speed",
            status: "disabled",
          },
        },
      },
    });

    collapseBuiltinProfilesToOverridesMigration.run(workspaceDir);

    const llm = readLlm();
    const overrides = llm.profileOverrides as Record<
      string,
      Record<string, unknown>
    >;
    expect(llm.profiles).toEqual({});
    // balanced had only a seed-default label — no override entry at all.
    expect(overrides.balanced).toBeUndefined();
    // cost-optimized lifts only the status; the seed-default label is dropped.
    expect(overrides["cost-optimized"]).toEqual({ status: "disabled" });
  });

  test("BYOK-suffixed seed-default labels are NOT lifted", () => {
    writeConfig({
      llm: {
        profiles: {
          balanced: { source: "managed", label: "Balanced (Managed)" },
          "quality-optimized": {
            source: "managed",
            label: "Quality (Managed)",
          },
          "cost-optimized": { source: "managed", label: "Speed (Managed)" },
          "balanced-economy": {
            source: "managed",
            label: "Balanced Economy (Managed)",
          },
        },
      },
    });

    collapseBuiltinProfilesToOverridesMigration.run(workspaceDir);

    const llm = readLlm();
    expect(llm.profiles).toEqual({});
    expect(llm.profileOverrides).toBeUndefined();
  });

  test("explicit label: null lifts as null", () => {
    writeConfig({
      llm: {
        profiles: {
          balanced: { source: "managed", label: null },
        },
      },
    });

    collapseBuiltinProfilesToOverridesMigration.run(workspaceDir);

    const overrides = readLlm().profileOverrides as Record<
      string,
      Record<string, unknown>
    >;
    expect("label" in overrides.balanced!).toBe(true);
    expect(overrides.balanced!.label).toBeNull();
  });

  test("explicit status: null lifts as null", () => {
    writeConfig({
      llm: {
        profiles: {
          balanced: { source: "managed", status: null },
        },
      },
    });

    collapseBuiltinProfilesToOverridesMigration.run(workspaceDir);

    const overrides = readLlm().profileOverrides as Record<
      string,
      Record<string, unknown>
    >;
    expect("status" in overrides.balanced!).toBe(true);
    expect(overrides.balanced!.status).toBeNull();
  });

  test("never clobbers a pre-existing profileOverrides key", () => {
    // The PUT route may have written overrides before the migration ran.
    writeConfig({
      llm: {
        profiles: {
          balanced: {
            source: "managed",
            label: "Stale Rename",
            status: "disabled",
          },
          "quality-optimized": {
            source: "managed",
            label: "Stale Quality Rename",
          },
        },
        profileOverrides: {
          balanced: { label: "Route Rename" },
        },
      },
    });

    collapseBuiltinProfilesToOverridesMigration.run(workspaceDir);

    const overrides = readLlm().profileOverrides as Record<
      string,
      Record<string, unknown>
    >;
    // Existing label key survives; the stale status still lifts alongside it.
    expect(overrides.balanced).toEqual({
      label: "Route Rename",
      status: "disabled",
    });
    // Profiles without a pre-existing override lift normally.
    expect(overrides["quality-optimized"]).toEqual({
      label: "Stale Quality Rename",
    });
  });

  test("is idempotent — second run produces no further changes", () => {
    writeConfig({
      llm: {
        profiles: {
          balanced: {
            source: "managed",
            label: "My Balanced",
            status: "disabled",
          },
        },
      },
    });

    collapseBuiltinProfilesToOverridesMigration.run(workspaceDir);
    const afterFirst = readFileSync(join(workspaceDir, "config.json"), "utf-8");

    collapseBuiltinProfilesToOverridesMigration.run(workspaceDir);
    const afterSecond = readFileSync(
      join(workspaceDir, "config.json"),
      "utf-8",
    );

    expect(afterSecond).toBe(afterFirst);
  });

  test("config with no built-in entries is untouched — no spurious write", () => {
    writeConfig({
      llm: {
        profiles: {
          "my-custom": { provider: "anthropic", model: "claude-opus-4-8" },
        },
        activeProfile: "my-custom",
      },
    });
    const before = readFileSync(join(workspaceDir, "config.json"), "utf-8");

    collapseBuiltinProfilesToOverridesMigration.run(workspaceDir);

    const after = readFileSync(join(workspaceDir, "config.json"), "utf-8");
    expect(after).toBe(before);
  });

  test("custom (non-built-in) profiles are untouched while built-ins collapse", () => {
    writeConfig({
      llm: {
        profiles: {
          balanced: { source: "managed", label: "Renamed" },
          "my-custom": {
            provider: "openai",
            model: "gpt-5.4",
            label: "Mine",
            source: "user",
          },
        },
      },
    });

    collapseBuiltinProfilesToOverridesMigration.run(workspaceDir);

    const llm = readLlm();
    const profiles = llm.profiles as Record<string, unknown>;
    expect(profiles["my-custom"]).toEqual({
      provider: "openai",
      model: "gpt-5.4",
      label: "Mine",
      source: "user",
    });
    expect("balanced" in profiles).toBe(false);
  });

  test("profileOrder is left untouched", () => {
    const order = ["auto", "balanced", "balanced-economy", "my-custom"];
    writeConfig({
      llm: {
        profiles: {
          balanced: { source: "managed" },
        },
        profileOrder: order,
      },
    });

    collapseBuiltinProfilesToOverridesMigration.run(workspaceDir);

    expect(readLlm().profileOrder).toEqual(order);
  });

  test("no-op when config.json does not exist", () => {
    collapseBuiltinProfilesToOverridesMigration.run(workspaceDir);
    expect(existsSync(join(workspaceDir, "config.json"))).toBe(false);
  });

  test("no-op when llm.profiles is absent", () => {
    writeConfig({ llm: { default: { provider: "anthropic" } } });
    const before = readFileSync(join(workspaceDir, "config.json"), "utf-8");

    collapseBuiltinProfilesToOverridesMigration.run(workspaceDir);

    const after = readFileSync(join(workspaceDir, "config.json"), "utf-8");
    expect(after).toBe(before);
  });

  test("ignores malformed config.json without throwing", () => {
    writeFileSync(join(workspaceDir, "config.json"), "{ not valid json");
    expect(() =>
      collapseBuiltinProfilesToOverridesMigration.run(workspaceDir),
    ).not.toThrow();
  });
});
