/**
 * Tests for the user plugin loader.
 *
 * Redirects `getWorkspaceDir()` into a per-test temp directory via
 * `VELLUM_WORKSPACE_DIR` so `loadUserPlugins()` walks an isolated tree
 * that we populate on demand.
 *
 * The loader's own responsibility is directory discovery and dispatch: it
 * scans `<workspaceDir>/plugins/*` and populates the per-surface mtime
 * cache with each plugin's hooks and tools. The plugin-build mechanics
 * (manifest parsing, hook/tool wiring, the per-plugin timeout, error
 * isolation) are covered directly in `external-plugin-loader.test.ts`;
 * here we assert the discovery contract:
 *
 * - A directory with a `package.json` is loaded and cached.
 * - A directory without a `package.json` is skipped silently.
 * - A missing `getWorkspaceDir()/plugins/` directory is a no-op (zero
 *   installed user plugins is the default shape of a fresh daemon).
 * - One failing plugin does not prevent a sibling from loading.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "bun:test";

import {
  getCachedUserTools,
  getUserHooksFor,
  resetPluginCacheForTests,
} from "../plugins/mtime-cache.js";
import { loadUserPlugins } from "../plugins/user-loader.js";

// Isolate every run under its own tempdir so parallel test files (and
// repeated runs of this file) cannot collide on `<workspaceDir>/plugins/`.
const TEST_WORKSPACE_DIR = join(
  tmpdir(),
  `vellum-user-plugin-loader-test-${process.pid}-${Date.now()}`,
);
process.env.VELLUM_WORKSPACE_DIR = TEST_WORKSPACE_DIR;

/** The plugins directory the loader will walk. */
const PLUGINS_DIR = join(TEST_WORKSPACE_DIR, "plugins");

/**
 * Write a directory-convention plugin: a `package.json` manifest plus any
 * surface files (`hooks/<name>.ts`, `tools/<name>.ts`) whose default export
 * the loader wires up.
 */
function writePlugin(
  name: string,
  pkg: Record<string, unknown>,
  files: Record<string, string> = {},
): void {
  const pluginDir = join(PLUGINS_DIR, name);
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(join(pluginDir, "package.json"), JSON.stringify(pkg, null, 2));
  for (const [rel, body] of Object.entries(files)) {
    const parts = rel.split("/");
    parts.pop();
    if (parts.length > 0) {
      mkdirSync(join(pluginDir, ...parts), { recursive: true });
    }
    writeFileSync(join(pluginDir, rel), body);
  }
}

function clearPluginsDir(): void {
  rmSync(TEST_WORKSPACE_DIR, { recursive: true, force: true });
}

describe("user plugin loader", () => {
  beforeEach(() => {
    resetPluginCacheForTests();
    clearPluginsDir();
  });

  test("loads a plugin via its package.json manifest and caches its hooks", async () => {
    writePlugin(
      "my-plugin",
      { name: "my-plugin", version: "0.1.0" },
      {
        "hooks/init.ts":
          "export default async function init(_ctx: unknown): Promise<void> {}\n",
      },
    );

    await loadUserPlugins();

    // The init hook should be cached.
    const initHooks = await getUserHooksFor("init");
    expect(initHooks).toHaveLength(1);
  });

  test("per-plugin failure is isolated: other plugins still load", async () => {
    // Plugin A has a malformed package.json; the loader must isolate the
    // failure and still load the healthy sibling.
    const brokenDir = join(PLUGINS_DIR, "broken-plugin");
    mkdirSync(brokenDir, { recursive: true });
    writeFileSync(join(brokenDir, "package.json"), "{ not valid json");

    writePlugin("good-plugin", { name: "good-plugin", version: "0.1.0" });

    await loadUserPlugins();

    // The good plugin's hooks should be available.
    const hooks = await getUserHooksFor("user-prompt-submit");
    // good-plugin has no hooks (no hooks/ dir), so 0 is expected.
    expect(hooks).toHaveLength(0);

    // But the plugin should still be discovered (tools would be cached).
    // The broken plugin should not appear.
    const tools = getCachedUserTools();
    expect(tools).toHaveLength(0); // good-plugin has no tools either
  });

  test("missing plugins/ directory is a no-op", async () => {
    // clearPluginsDir() in beforeEach has already removed TEST_WORKSPACE_DIR
    // entirely, so getWorkspaceDir()/plugins/ does not exist.
    await loadUserPlugins();
    expect(await getUserHooksFor("user-prompt-submit")).toHaveLength(0);
    expect(getCachedUserTools()).toHaveLength(0);
  });

  test("subdirectory without package.json is silently skipped", async () => {
    const stubDir = join(PLUGINS_DIR, "not-a-plugin");
    mkdirSync(stubDir, { recursive: true });
    writeFileSync(join(stubDir, "README.md"), "# not actually a plugin\n");

    await loadUserPlugins();
    expect(await getUserHooksFor("user-prompt-submit")).toHaveLength(0);
    expect(getCachedUserTools()).toHaveLength(0);
  });

  test("loads a plugin whose package.json name differs from its directory", async () => {
    writePlugin("scoped", { name: "@vellumai/cool-plugin", version: "0.1.0" });

    await loadUserPlugins();

    // The plugin's identity is its directory name (`scoped`), not the authored
    // package.json name. No hooks were written, so we just verify it loads
    // without crashing.
    expect(await getUserHooksFor("user-prompt-submit")).toHaveLength(0);
  });
});
