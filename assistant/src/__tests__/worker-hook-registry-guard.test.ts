/**
 * Guard test: hook dispatch is self-populating
 *
 * The standalone memory jobs worker (`plugins/defaults/memory/worker.ts`) and
 * the schedule worker (`schedule/worker.ts`) host real agent conversations —
 * retrospective and consolidation passes, scheduled runs, plus any subagents
 * they spawn — and those turns run the same `agent/loop.ts` hook chain the
 * daemon does. Neither process runs plugin bootstrap, so a dispatch that
 * required prior registration would resolve against an empty registry and
 * silently skip every hook: no `tool-result-truncate` on oversized results, no
 * `tool-error` retry coaching, no `empty-response` re-query, no
 * `conversation-deleted` cleanup.
 *
 * The contract pinned here is that a worker needs no registration call at all —
 * the first read of a hook name populates from all three sources (first-party
 * defaults, discovered user plugins, standalone workspace hooks). This is the
 * hook-registry analogue of `memory-worker-tool-registry-guard.test.ts`, which
 * pins the same property for the tool registry.
 *
 * The load-bearing half is the second test: populating must be REGISTRATION,
 * never ACTIVATION. Running plugin `init` in a worker would run daemon-owned
 * lifecycle in the wrong process — and for `default-memory` specifically,
 * `init` calls `runMemoryStartup`, which starts the memory jobs worker, so the
 * memory worker would try to spawn a memory worker from inside itself.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { getHookEntriesFor } from "../hooks/registry.js";
import { resetPluginCacheForTests } from "../plugins/mtime-cache.js";
import { resetPluginRegistryForTests } from "../plugins/registry.js";
import {
  getWorkspaceHooksDir,
  getWorkspacePluginsDir,
} from "../util/platform.js";

const pluginsRoot = getWorkspacePluginsDir();
const workspaceHooksDir = getWorkspaceHooksDir();

/** Marker the fixture plugin's `init` writes if it is ever run. */
const initMarker = join(pluginsRoot, "init-ran.marker");

const PASSTHROUGH_HOOK = "export default function (ctx) { return ctx; }\n";

/**
 * Fixture user plugin carrying a `post-tool-use` hook and an `init` that
 * writes {@link initMarker} — so "was this plugin activated?" is observable.
 */
function writeFixturePlugin(name: string): string {
  const dir = join(pluginsRoot, name);
  mkdirSync(join(dir, "hooks"), { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name, version: "1.0.0" }),
  );
  writeFileSync(join(dir, "hooks", "post-tool-use.ts"), PASSTHROUGH_HOOK);
  writeFileSync(
    join(dir, "hooks", "init.ts"),
    `import { writeFileSync } from "node:fs";\n` +
      `export default function () { writeFileSync(${JSON.stringify(initMarker)}, "ran"); }\n`,
  );
  return dir;
}

/** Owner ids for a hook name, in chain order. */
async function ownersFor(hookName: string): Promise<string[]> {
  const entries = await getHookEntriesFor(hookName);
  return entries.map((e) => e.owner.id);
}

/**
 * Drop every registration the process has accumulated, so the next dispatch
 * starts from the same empty state a freshly booted worker does.
 */
function simulateFreshWorkerProcess(): void {
  resetPluginRegistryForTests();
  resetPluginCacheForTests();
}

beforeEach(() => {
  rmSync(pluginsRoot, { recursive: true, force: true });
  rmSync(workspaceHooksDir, { recursive: true, force: true });
  mkdirSync(pluginsRoot, { recursive: true });
  simulateFreshWorkerProcess();
});

afterEach(() => {
  rmSync(pluginsRoot, { recursive: true, force: true });
  rmSync(workspaceHooksDir, { recursive: true, force: true });
  simulateFreshWorkerProcess();
});

describe("hook dispatch in a worker process", () => {
  test("registers the first-party defaults with no bootstrap call", async () => {
    const owners = await ownersFor("post-tool-use");

    // The specific defaults a background pass depends on. Named individually
    // rather than by count so a plugin that stops contributing the hook fails
    // here instead of being masked by a new one arriving.
    expect(owners).toContain("default-tool-result-truncate");
    expect(owners).toContain("default-tool-error");

    // `conversation-deleted` fires from the shared delete primitives, which the
    // memory retrospective drives in-process when it GCs its own forks.
    expect(await ownersFor("conversation-deleted")).toContain("default-memory");
  });

  test("discovers user plugins without running their init", async () => {
    writeFixturePlugin("fixture-worker-plugin");

    expect(await ownersFor("post-tool-use")).toContain("fixture-worker-plugin");

    // The whole point of the split: discovery populated the plugin set and the
    // hook resolved from disk, but no plugin lifecycle ran in this process.
    expect(existsSync(initMarker)).toBe(false);
  });

  test("chains defaults, then user plugins, then workspace hooks", async () => {
    writeFixturePlugin("fixture-order-plugin");
    mkdirSync(workspaceHooksDir, { recursive: true });
    writeFileSync(
      join(workspaceHooksDir, "post-tool-use.ts"),
      PASSTHROUGH_HOOK,
    );

    const owners = await ownersFor("post-tool-use");
    const pluginIdx = owners.indexOf("fixture-order-plugin");
    const workspaceIdx = owners.length - 1;
    const lastDefaultIdx = owners.reduce(
      (acc, id, i) => (id.startsWith("default-") ? i : acc),
      -1,
    );

    expect(lastDefaultIdx).toBeGreaterThanOrEqual(0);
    expect(pluginIdx).toBeGreaterThan(lastDefaultIdx);
    expect(workspaceIdx).toBeGreaterThan(pluginIdx);
  });

  test("skips a user plugin carrying the .disabled sentinel", async () => {
    const dir = writeFixturePlugin("fixture-disabled-plugin");
    writeFileSync(join(dir, ".disabled"), "");

    expect(await ownersFor("post-tool-use")).not.toContain(
      "fixture-disabled-plugin",
    );
    expect(existsSync(initMarker)).toBe(false);
  });
});
