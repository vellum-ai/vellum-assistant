/**
 * Tests for the unattended plugin upgrade sweep, driven one pass at a time
 * (no timers) against a temp workspace: a real `config.json`, real plugin
 * directories, and a real on-disk sweep stamp. Only the two network-bound
 * seams are mocked — the marketplace drift check and the daemon IPC call.
 *
 * The contract under test:
 *   - a `manual` workspace (the default) never asks the daemon for anything;
 *   - an `auto` workspace sweeps at most once per `checkIntervalMs`, and the
 *     stamp survives restarts;
 *   - only plugins that can actually move reach the daemon — up-to-date and
 *     disabled installs cost it nothing;
 *   - one plugin's refusal does not stop the sweep, an unreachable daemon
 *     abandons it without stamping (so it retries), and a timed-out upgrade
 *     abandons it *with* a stamp (so the retry cannot race the handler that
 *     is still running);
 *   - the configured strategy is what the daemon is asked for.
 */

import {
  existsSync,
  mkdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

const ROOT = join(
  tmpdir(),
  `plugin-auto-update-test-${process.pid}-${Date.now()}`,
);
const PLUGINS_DIR = join(ROOT, "plugins");
const MONITORING_DIR = join(ROOT, "data", "monitoring");
const STAMP = join(MONITORING_DIR, "plugin-auto-update-last-run-at");
const CONFIG_PATH = join(ROOT, "config.json");

process.env.VELLUM_WORKSPACE_DIR = ROOT;
mkdirSync(MONITORING_DIR, { recursive: true });
mkdirSync(PLUGINS_DIR, { recursive: true });

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

// ── Mocked seams: the marketplace drift check and the daemon call ───────────
//
// `mock.module` replaces the module for the whole test process, so each
// factory spreads the real module and overrides only the one export this
// file drives. Replacing either wholesale would strip the other exports out
// from under any test file running alongside this one.

/** Drift status `inspectPlugin` reports per plugin name. */
let inspectStatus = new Map<string, string>();
let inspectThrowsFor = new Set<string>();

type UpgradeReply = {
  ok: boolean;
  result?: { outcome?: string; toCommit?: string };
  error?: string;
  statusCode?: number;
  timedOut?: boolean;
};
let upgradeReply: (name: string) => UpgradeReply = () => ({
  ok: true,
  result: { outcome: "upgraded", toCommit: "abc1234" },
});
const upgradeCalls: Array<{ name: string; strategy: unknown }> = [];

const realInspect = await import("../../cli/lib/inspect-plugin.js");
const realIpcClient = await import("../../ipc/cli-client.js");

mock.module("../../cli/lib/inspect-plugin.js", () => ({
  ...realInspect,
  inspectPlugin: async ({ name }: { name: string }) => {
    if (inspectThrowsFor.has(name)) {
      throw new Error("marketplace unreachable");
    }
    return { name, status: inspectStatus.get(name) ?? "up-to-date" };
  },
}));

mock.module("../../ipc/cli-client.js", () => ({
  ...realIpcClient,
  cliIpcCall: async (
    _method: string,
    params: { pathParams: { name: string }; body: { strategy: unknown } },
  ) => {
    upgradeCalls.push({
      name: params.pathParams.name,
      strategy: params.body.strategy,
    });
    return upgradeReply(params.pathParams.name);
  },
}));

const { invalidateConfigCache } = await import("../../config/loader.js");
const { runPluginAutoUpdateSweepIfDue } =
  await import("../plugin-auto-update.js");

// ── Workspace fixtures ──────────────────────────────────────────────────────

function writeConfig(pluginUpdates: Record<string, unknown>): void {
  writeFileSync(CONFIG_PATH, JSON.stringify({ pluginUpdates }, null, 2));
  invalidateConfigCache();
}

/** Materialize an installed plugin and declare what inspect says about it. */
function installPlugin(
  name: string,
  opts: { status?: string; disabled?: boolean } = {},
): void {
  const dir = join(PLUGINS_DIR, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name, version: "1.0.0" }),
  );
  if (opts.disabled) {
    writeFileSync(join(dir, ".disabled"), "");
  }
  inspectStatus.set(name, opts.status ?? "update-available");
}

/** Backdate the stamp so the sweep is (or is not) due again. */
function stampAgedBy(ms: number): void {
  writeFileSync(STAMP, "");
  const when = new Date(Date.now() - ms);
  utimesSync(STAMP, when, when);
}

beforeEach(() => {
  inspectStatus = new Map();
  inspectThrowsFor = new Set();
  upgradeReply = () => ({
    ok: true,
    result: { outcome: "upgraded", toCommit: "abc1234" },
  });
  upgradeCalls.length = 0;
  rmSync(STAMP, { force: true });
  rmSync(PLUGINS_DIR, { recursive: true, force: true });
  mkdirSync(PLUGINS_DIR, { recursive: true });
  writeConfig({});
});

describe("plugin auto-update sweep", () => {
  test("defaults to manual: nothing is upgraded and nothing is stamped", async () => {
    installPlugin("alpha");
    const result = await runPluginAutoUpdateSweepIfDue();
    expect(result.skipped).toBe("manual");
    expect(upgradeCalls).toEqual([]);
    expect(existsSync(STAMP)).toBe(false);
  });

  test("auto mode upgrades every candidate with the configured strategy", async () => {
    writeConfig({ mode: "auto" });
    installPlugin("alpha", { status: "update-available" });
    installPlugin("beta", { status: "unknown-provenance" });

    const result = await runPluginAutoUpdateSweepIfDue();

    expect(result.skipped).toBeNull();
    expect(result.upgraded).toEqual(["alpha", "beta"]);
    expect(upgradeCalls).toEqual([
      { name: "alpha", strategy: "theirs" },
      { name: "beta", strategy: "theirs" },
    ]);
  });

  test("a non-default strategy is what the daemon is asked for", async () => {
    writeConfig({ mode: "auto", strategy: "overwrite" });
    installPlugin("alpha");

    await runPluginAutoUpdateSweepIfDue();

    expect(upgradeCalls).toEqual([{ name: "alpha", strategy: "overwrite" }]);
  });

  test("up-to-date plugins never reach the daemon", async () => {
    writeConfig({ mode: "auto" });
    installPlugin("alpha", { status: "up-to-date" });
    installPlugin("beta", { status: "update-available" });

    const result = await runPluginAutoUpdateSweepIfDue();

    expect(upgradeCalls).toEqual([{ name: "beta", strategy: "theirs" }]);
    expect(result.upgraded).toEqual(["beta"]);
  });

  test("a plugin whose drift cannot be resolved is skipped, not attempted", async () => {
    writeConfig({ mode: "auto" });
    // The catalog was unreachable for one, and the inspect call itself blew
    // up for the other; an upgrade would hit the same failure.
    installPlugin("alpha", { status: "remote-unavailable" });
    installPlugin("gamma", { status: "update-available" });
    inspectThrowsFor = new Set(["gamma"]);
    installPlugin("beta", { status: "update-available" });

    await runPluginAutoUpdateSweepIfDue();

    expect(upgradeCalls.map((c) => c.name)).toEqual(["beta"]);
  });

  test("a disabled plugin is left alone", async () => {
    writeConfig({ mode: "auto" });
    installPlugin("alpha");
    installPlugin("beta", { disabled: true });

    await runPluginAutoUpdateSweepIfDue();

    expect(upgradeCalls.map((c) => c.name)).toEqual(["alpha"]);
  });

  test("an up-to-date daemon verdict counts as unchanged, not upgraded", async () => {
    writeConfig({ mode: "auto" });
    installPlugin("alpha");
    upgradeReply = () => ({
      ok: true,
      result: { outcome: "already-up-to-date" },
    });

    const result = await runPluginAutoUpdateSweepIfDue();

    expect(result.upgraded).toEqual([]);
    expect(result.unchanged).toEqual(["alpha"]);
  });

  test("a sweep inside the interval is skipped", async () => {
    writeConfig({ mode: "auto" });
    installPlugin("alpha");
    stampAgedBy(60_000);

    const result = await runPluginAutoUpdateSweepIfDue();

    expect(result.skipped).toBe("not-due");
    expect(upgradeCalls).toEqual([]);
  });

  test("a sweep past the interval runs again", async () => {
    writeConfig({ mode: "auto" });
    installPlugin("alpha");
    stampAgedBy(3_600_001);

    const result = await runPluginAutoUpdateSweepIfDue();

    expect(result.skipped).toBeNull();
    expect(upgradeCalls.length).toBe(1);
  });

  test("a shortened interval is honored", async () => {
    writeConfig({ mode: "auto", checkIntervalMs: 300_000 });
    installPlugin("alpha");
    stampAgedBy(400_000);

    expect((await runPluginAutoUpdateSweepIfDue()).skipped).toBeNull();
  });

  test("one plugin's refusal does not stop the rest, and the sweep stamps", async () => {
    writeConfig({ mode: "auto" });
    installPlugin("alpha");
    installPlugin("beta");
    upgradeReply = (name) =>
      name === "alpha"
        ? { ok: false, statusCode: 409, error: "not upgradable" }
        : { ok: true, result: { outcome: "upgraded" } };

    const result = await runPluginAutoUpdateSweepIfDue();

    expect(result.failed).toEqual(["alpha"]);
    expect(result.upgraded).toEqual(["beta"]);
    expect(result.daemonUnreachable).toBe(false);
    // Stamped: the next attempt is an interval away.
    expect(await runPluginAutoUpdateSweepIfDue()).toMatchObject({
      skipped: "not-due",
    });
  });

  test("an unreachable daemon abandons the sweep and stays due", async () => {
    writeConfig({ mode: "auto" });
    installPlugin("alpha");
    installPlugin("beta");
    upgradeReply = () => ({ ok: false, error: "connect ENOENT" });

    const result = await runPluginAutoUpdateSweepIfDue();

    expect(result.daemonUnreachable).toBe(true);
    // Abandoned after the first plugin — the rest would fail identically.
    expect(upgradeCalls.map((c) => c.name)).toEqual(["alpha"]);

    // Unstamped, so the next poll retries immediately.
    upgradeCalls.length = 0;
    upgradeReply = () => ({ ok: true, result: { outcome: "upgraded" } });
    const retry = await runPluginAutoUpdateSweepIfDue();
    expect(retry.skipped).toBeNull();
    expect(retry.upgraded).toEqual(["alpha", "beta"]);
  });

  test("a timed-out upgrade stamps, so the retry cannot race the daemon handler", async () => {
    writeConfig({ mode: "auto" });
    installPlugin("alpha");
    installPlugin("beta");
    upgradeReply = (name) =>
      name === "alpha"
        ? { ok: false, error: "Request timed out", timedOut: true }
        : { ok: true, result: { outcome: "upgraded" } };

    const result = await runPluginAutoUpdateSweepIfDue();

    expect(result.failed).toEqual(["alpha"]);
    // The daemon may still be swapping `alpha`; nothing is queued behind it.
    expect(upgradeCalls.map((c) => c.name)).toEqual(["alpha"]);
    expect(result.daemonUnreachable).toBe(false);
    expect(await runPluginAutoUpdateSweepIfDue()).toMatchObject({
      skipped: "not-due",
    });
  });

  test("a workspace with nothing to move stamps instead of re-inspecting every minute", async () => {
    writeConfig({ mode: "auto" });
    installPlugin("alpha", { status: "up-to-date" });

    const result = await runPluginAutoUpdateSweepIfDue();

    expect(result.skipped).toBe("no-candidates");
    expect(upgradeCalls).toEqual([]);
    expect(await runPluginAutoUpdateSweepIfDue()).toMatchObject({
      skipped: "not-due",
    });
  });
});
