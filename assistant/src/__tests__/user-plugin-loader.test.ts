/**
 * Tests for the user plugin loader (PR 29).
 *
 * Redirects `vellumRoot()` into a per-test temp directory via `BASE_DATA_DIR`
 * (the canonical multi-instance override read by `util/platform.ts`) so
 * `loadUserPlugins()` walks an isolated tree that we populate on demand.
 *
 * Covers:
 * - A plugin whose `register.ts` calls `registerPlugin()` at import time
 *   ends up in the registry after `loadUserPlugins()` resolves.
 * - A plugin whose `register.ts` throws during import is logged + skipped;
 *   other plugins in the same directory still load.
 * - A missing `vellumRoot()/plugins/` directory is a no-op (zero installed
 *   user plugins is the default shape of a fresh daemon).
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
// repeated runs of this file) cannot collide on `~/.vellum/plugins/`.
// Each describe-scope gets a fresh subdirectory.
const TEST_INSTANCE_DIR = join(
  tmpdir(),
  `vellum-user-plugin-loader-test-${process.pid}-${Date.now()}`,
);
process.env.BASE_DATA_DIR = TEST_INSTANCE_DIR;

/** The plugins directory the loader will walk. */
const PLUGINS_DIR = join(TEST_INSTANCE_DIR, ".vellum", "plugins");

/**
 * Write a plugin directory with a `register.ts` (TypeScript source, so bun
 * can import it at test time without a build step) that executes the given
 * body. The body has access to `registerPlugin` via a relative import back
 * into the repo's registry module.
 *
 * `relativeRegistryImport` points from the synthetic plugin file at
 * `<TEST_INSTANCE_DIR>/.vellum/plugins/<name>/register.ts` to the real
 * registry source at `<repo>/assistant/src/plugins/registry.ts`. Using a
 * relative path (rather than a project-root alias) keeps the test hermetic
 * and matches how an on-disk user plugin would actually import the
 * registry's public API in a real install.
 */
function writePlugin(name: string, body: string): void {
  const pluginDir = join(PLUGINS_DIR, name);
  mkdirSync(pluginDir, { recursive: true });
  // Resolve the absolute path to the registry module so the synthetic
  // register.ts can import it. bun happily resolves `.ts` files at runtime
  // when the test suite itself is running in source mode.
  const registryPath = join(import.meta.dir, "..", "plugins", "registry.ts");
  const registerSource = `
import { registerPlugin } from ${JSON.stringify(registryPath)};
${body}
`;
  writeFileSync(join(pluginDir, "register.ts"), registerSource);
}

function clearPluginsDir(): void {
  rmSync(TEST_INSTANCE_DIR, { recursive: true, force: true });
}

describe("user plugin loader", () => {
  beforeEach(() => {
    resetPluginRegistryForTests();
    clearPluginsDir();
  });

  test("loads a valid plugin whose register.ts calls registerPlugin()", async () => {
    writePlugin(
      "my-plugin",
      `
registerPlugin({
  manifest: {
    name: "my-plugin",
    version: "0.0.1",
    requires: { pluginRuntime: "v1" },
  },
});
`,
    );

    await loadUserPlugins();

    const registered = getRegisteredPlugins();
    expect(registered).toHaveLength(1);
    expect(registered[0]?.manifest.name).toBe("my-plugin");
  });

  test("per-plugin failure is isolated: other plugins still load", async () => {
    // Plugin A throws at import time. The loader must log and move on so
    // Plugin B still ends up registered — one bad user plugin cannot brick
    // the entire user-plugin surface or crash the daemon.
    writePlugin(
      "broken-plugin",
      `
throw new Error("boom at import time");
`,
    );
    writePlugin(
      "good-plugin",
      `
registerPlugin({
  manifest: {
    name: "good-plugin",
    version: "0.0.1",
    requires: { pluginRuntime: "v1" },
  },
});
`,
    );

    await loadUserPlugins();

    const registered = getRegisteredPlugins();
    const names = registered.map((p) => p.manifest.name);
    // Order is not guaranteed (filesystem-dependent) — assert membership.
    expect(names).toContain("good-plugin");
    expect(names).not.toContain("broken-plugin");
  });

  test("missing plugins/ directory is a no-op", async () => {
    // clearPluginsDir() in beforeEach has already removed TEST_INSTANCE_DIR
    // entirely, so vellumRoot()/plugins/ does not exist. The loader must
    // complete without throwing and without registering anything.
    await loadUserPlugins();
    expect(getRegisteredPlugins()).toHaveLength(0);
  });

  test("subdirectory without register.{ts,js} is silently skipped", async () => {
    // Populate a directory that looks like a plugin but lacks a register
    // file. The loader must skip it without throwing.
    const stubDir = join(PLUGINS_DIR, "not-a-plugin");
    mkdirSync(stubDir, { recursive: true });
    writeFileSync(join(stubDir, "README.md"), "# not actually a plugin\n");

    await loadUserPlugins();
    expect(getRegisteredPlugins()).toHaveLength(0);
  });
});
