/**
 * Tests for the user plugin loader.
 *
 * Redirects `getWorkspaceDir()` into a per-test temp directory via
 * `VELLUM_WORKSPACE_DIR` so `loadUserPlugins()` walks an isolated tree
 * that we populate on demand.
 *
 * The loader's own responsibility is directory discovery and dispatch: it
 * scans `<workspaceDir>/plugins/*` and hands every subdirectory carrying a
 * `package.json` to `loadExternalPlugin`. The plugin-build mechanics
 * (manifest parsing, hook/tool wiring, the per-plugin timeout, error
 * isolation) are covered directly in `external-plugin-loader.test.ts`; here
 * we assert the discovery contract:
 *
 * - A directory with a `package.json` is loaded and registered.
 * - A directory without a `package.json` is skipped silently.
 * - A missing `getWorkspaceDir()/plugins/` directory is a no-op (zero
 *   installed user plugins is the default shape of a fresh daemon).
 * - One failing plugin does not prevent a sibling from registering.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "bun:test";

import {
  getRegisteredPlugins,
  resetPluginRegistryForTests,
} from "../plugins/registry.js";
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
    resetPluginRegistryForTests();
    clearPluginsDir();
  });

  test("loads a plugin via its package.json manifest and registers it", async () => {
    writePlugin(
      "my-plugin",
      { name: "my-plugin", version: "0.1.0" },
      {
        "hooks/init.ts":
          "export default async function init(_ctx: unknown): Promise<void> {}\n",
      },
    );

    await loadUserPlugins();

    const registered = getRegisteredPlugins();
    expect(registered).toHaveLength(1);
    expect(registered[0]?.manifest.name).toBe("my-plugin");
    expect(typeof registered[0]?.hooks?.init).toBe("function");
  });

  test("per-plugin failure is isolated: other plugins still load", async () => {
    // Plugin A has a malformed package.json; the loader must isolate the
    // failure and still register the healthy sibling — one bad user plugin
    // cannot brick the entire user-plugin surface or crash the daemon.
    const brokenDir = join(PLUGINS_DIR, "broken-plugin");
    mkdirSync(brokenDir, { recursive: true });
    writeFileSync(join(brokenDir, "package.json"), "{ not valid json");

    writePlugin("good-plugin", { name: "good-plugin", version: "0.1.0" });

    await loadUserPlugins();

    const names = getRegisteredPlugins().map((p) => p.manifest.name);
    // Order is not guaranteed (filesystem-dependent) — assert membership.
    expect(names).toContain("good-plugin");
    expect(names).not.toContain("broken-plugin");
  });

  test("missing plugins/ directory is a no-op", async () => {
    // clearPluginsDir() in beforeEach has already removed TEST_WORKSPACE_DIR
    // entirely, so getWorkspaceDir()/plugins/ does not exist. The loader must
    // complete without throwing and without registering anything.
    await loadUserPlugins();
    expect(getRegisteredPlugins()).toHaveLength(0);
  });

  test("subdirectory without package.json is silently skipped", async () => {
    // Populate a directory that looks like a plugin but lacks a manifest.
    // The loader must skip it without throwing.
    const stubDir = join(PLUGINS_DIR, "not-a-plugin");
    mkdirSync(stubDir, { recursive: true });
    writeFileSync(join(stubDir, "README.md"), "# not actually a plugin\n");

    await loadUserPlugins();
    expect(getRegisteredPlugins()).toHaveLength(0);
  });

  test("strips npm scope from package.json name", async () => {
    writePlugin("scoped", { name: "@vellumai/cool-plugin", version: "0.1.0" });

    await loadUserPlugins();

    const names = getRegisteredPlugins().map((p) => p.manifest.name);
    expect(names).toContain("cool-plugin");
  });
});
