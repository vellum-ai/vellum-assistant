/**
 * Tests for the unattended plugin upgrade sweep, driven one pass at a time
 * (no timers) with every seam injected.
 *
 * The contract under test:
 *   - a `manual` workspace (the default) never asks the daemon for anything;
 *   - an `auto` workspace sweeps at most once per `checkIntervalMs`, and the
 *     stamp survives restarts;
 *   - one plugin's refusal does not stop the sweep, but an unreachable daemon
 *     abandons it without stamping, so it retries;
 *   - the configured strategy is what the daemon is asked for.
 */

import { describe, expect, test } from "bun:test";

import { PluginUpdatesConfigSchema } from "../../config/schemas/plugin-updates.js";
import {
  type PluginAutoUpdateDeps,
  runPluginAutoUpdatePassIfDue,
} from "../plugin-auto-update.js";

type UpgradeCall = { name: string; strategy: string };

function makeDeps(
  overrides: {
    config?: Partial<{
      mode: "manual" | "auto";
      strategy: "theirs" | "ours" | "overwrite";
      checkIntervalMs: number;
    }>;
    names?: string[];
    now?: number;
    lastRunAt?: number | null;
    upgrade?: PluginAutoUpdateDeps["requestUpgrade"];
  } = {},
): {
  deps: PluginAutoUpdateDeps;
  calls: UpgradeCall[];
  stamps: number[];
} {
  const calls: UpgradeCall[] = [];
  const stamps: number[] = [];
  const config = PluginUpdatesConfigSchema.parse(overrides.config ?? {});
  const now = overrides.now ?? 1_000_000_000;
  const upgrade: PluginAutoUpdateDeps["requestUpgrade"] =
    overrides.upgrade ??
    (async () => ({
      ok: true,
      result: { outcome: "upgraded", toCommit: "abc" },
    }));
  const deps: PluginAutoUpdateDeps = {
    readConfig: () => config,
    listUpgradableNames: () => overrides.names ?? ["alpha"],
    requestUpgrade: async (name, strategy) => {
      calls.push({ name, strategy });
      return upgrade(name, strategy);
    },
    readLastRunAt: () => overrides.lastRunAt ?? null,
    writeLastRunAt: () => stamps.push(now),
    now: () => now,
  };
  return { deps, calls, stamps };
}

describe("plugin auto-update pass", () => {
  test("defaults to manual: nothing is upgraded and nothing is stamped", async () => {
    const { deps, calls, stamps } = makeDeps();
    const result = await runPluginAutoUpdatePassIfDue(deps);
    expect(result.skipped).toBe("manual");
    expect(calls).toEqual([]);
    expect(stamps).toEqual([]);
  });

  test("auto mode upgrades every listed plugin with the configured strategy", async () => {
    const { deps, calls, stamps } = makeDeps({
      config: { mode: "auto" },
      names: ["alpha", "beta"],
    });
    const result = await runPluginAutoUpdatePassIfDue(deps);
    expect(result.skipped).toBeNull();
    expect(result.upgraded).toEqual(["alpha", "beta"]);
    expect(calls).toEqual([
      { name: "alpha", strategy: "theirs" },
      { name: "beta", strategy: "theirs" },
    ]);
    expect(stamps.length).toBe(1);
  });

  test("a non-default strategy is what the daemon is asked for", async () => {
    const { deps, calls } = makeDeps({
      config: { mode: "auto", strategy: "overwrite" },
    });
    await runPluginAutoUpdatePassIfDue(deps);
    expect(calls).toEqual([{ name: "alpha", strategy: "overwrite" }]);
  });

  test("an up-to-date plugin counts as unchanged, not upgraded", async () => {
    const { deps } = makeDeps({
      config: { mode: "auto" },
      upgrade: async () => ({
        ok: true,
        result: { outcome: "already-up-to-date" },
      }),
    });
    const result = await runPluginAutoUpdatePassIfDue(deps);
    expect(result.upgraded).toEqual([]);
    expect(result.unchanged).toEqual(["alpha"]);
  });

  test("a sweep inside the interval is skipped", async () => {
    const now = 5_000_000;
    const { deps, calls } = makeDeps({
      config: { mode: "auto", checkIntervalMs: 3_600_000 },
      now,
      lastRunAt: now - 3_599_999,
    });
    const result = await runPluginAutoUpdatePassIfDue(deps);
    expect(result.skipped).toBe("not-due");
    expect(calls).toEqual([]);
  });

  test("a sweep at exactly one interval is due", async () => {
    const now = 5_000_000;
    const { deps, calls } = makeDeps({
      config: { mode: "auto", checkIntervalMs: 3_600_000 },
      now,
      lastRunAt: now - 3_600_000,
    });
    const result = await runPluginAutoUpdatePassIfDue(deps);
    expect(result.skipped).toBeNull();
    expect(calls.length).toBe(1);
  });

  test("one plugin's refusal does not stop the rest, and the sweep stamps", async () => {
    const { deps, stamps } = makeDeps({
      config: { mode: "auto" },
      names: ["alpha", "beta"],
      upgrade: async (name) =>
        name === "alpha"
          ? { ok: false, statusCode: 409, error: "not upgradable" }
          : { ok: true, result: { outcome: "upgraded" } },
    });
    const result = await runPluginAutoUpdatePassIfDue(deps);
    expect(result.failed).toEqual(["alpha"]);
    expect(result.upgraded).toEqual(["beta"]);
    expect(result.daemonUnreachable).toBe(false);
    expect(stamps.length).toBe(1);
  });

  test("an unreachable daemon abandons the sweep and stays due", async () => {
    const { deps, calls, stamps } = makeDeps({
      config: { mode: "auto" },
      names: ["alpha", "beta"],
      upgrade: async () => ({ ok: false, error: "connect ENOENT" }),
    });
    const result = await runPluginAutoUpdatePassIfDue(deps);
    expect(result.daemonUnreachable).toBe(true);
    // Abandoned after the first plugin — the rest would fail identically.
    expect(calls).toEqual([{ name: "alpha", strategy: "theirs" }]);
    expect(stamps).toEqual([]);
  });

  test("a thrown upgrade is contained and counted as a failure", async () => {
    const { deps, stamps } = makeDeps({
      config: { mode: "auto" },
      upgrade: async () => {
        throw new Error("boom");
      },
    });
    const result = await runPluginAutoUpdatePassIfDue(deps);
    expect(result.failed).toEqual(["alpha"]);
    expect(stamps.length).toBe(1);
  });

  test("an empty workspace stamps instead of re-listing every minute", async () => {
    const { deps, calls, stamps } = makeDeps({
      config: { mode: "auto" },
      names: [],
    });
    const result = await runPluginAutoUpdatePassIfDue(deps);
    expect(result.skipped).toBe("no-plugins");
    expect(calls).toEqual([]);
    expect(stamps.length).toBe(1);
  });

  test("an unreadable config upgrades nothing", async () => {
    const { deps, calls } = makeDeps({ config: { mode: "auto" } });
    const broken: PluginAutoUpdateDeps = {
      ...deps,
      readConfig: () => {
        throw new Error("config.json is corrupt");
      },
    };
    const result = await runPluginAutoUpdatePassIfDue(broken);
    expect(result.skipped).toBe("config-unreadable");
    expect(calls).toEqual([]);
  });
});

describe("pluginUpdates config schema", () => {
  test("defaults are manual / theirs / hourly", () => {
    expect(PluginUpdatesConfigSchema.parse({})).toEqual({
      mode: "manual",
      strategy: "theirs",
      checkIntervalMs: 3_600_000,
    });
  });

  test("the unattended-hostile `assistant` strategy is not selectable", () => {
    expect(
      PluginUpdatesConfigSchema.safeParse({ strategy: "assistant" }).success,
    ).toBe(false);
  });

  test("sub-5-minute intervals are rejected", () => {
    expect(
      PluginUpdatesConfigSchema.safeParse({ checkIntervalMs: 1_000 }).success,
    ).toBe(false);
  });
});
