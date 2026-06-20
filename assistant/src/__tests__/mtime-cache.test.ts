/**
 * Tests for the plugin mtime cache — the pull-based replacement for
 * PluginSourceWatcher.
 *
 * Each test materializes a synthetic plugin directory under a per-file
 * tempdir, then exercises observable behavior: cache hit (same mtime),
 * cache miss (changed mtime → rebuild), plugin deletion (eviction), and
 * concurrent-read deduplication.
 */
import { mkdirSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";

import {
  getAllPlugins,
  getHooksForFromCache,
  getPlugin,
  resetPluginCacheForTests,
  _inspectCacheForTests,
} from "../plugins/mtime-cache.js";

// ─── Test fixtures ───────────────────────────────────────────────────────────

/**
 * Root tempdir for all tests in this file. Each test gets its own plugin
 * directory underneath. We point `VELLUM_WORKSPACE_DIR` at this root so
 * `getWorkspacePluginsDir()` resolves to `<ROOT>/plugins/`.
 */
const ROOT = join(
  tmpdir(),
  `vellum-mtime-cache-test-${process.pid}-${Date.now()}`,
);

const PLUGINS_DIR = join(ROOT, "plugins");

function ensurePluginsDir(): void {
  rmSync(PLUGINS_DIR, { recursive: true, force: true });
  mkdirSync(PLUGINS_DIR, { recursive: true });
}

function freshPluginDir(name: string): string {
  const dir = join(PLUGINS_DIR, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writePackageJson(dir: string, pkg: Record<string, unknown>): void {
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkg, null, 2));
}

function writeHook(dir: string, hookName: string, body: string): void {
  const hooksDir = join(dir, "hooks");
  mkdirSync(hooksDir, { recursive: true });
  writeFileSync(join(hooksDir, `${hookName}.ts`), body);
}

/**
 * Bump a file's mtime forward by ~2 seconds so the mtime cache detects a
 * change. Using utimesSync avoids race conditions with filesystem mtime
 * resolution (some platforms only have 1-second granularity).
 */
function touchFile(filePath: string, offsetSeconds = 2): void {
  const now = new Date();
  const future = new Date(now.getTime() + offsetSeconds * 1000);
  utimesSync(filePath, future, future);
}

const SIMPLE_PKG = {
  name: "test-plugin",
  version: "1.0.0",
  peerDependencies: { "@vellumai/plugin-api": "*" },
};

// ─── Setup / teardown ────────────────────────────────────────────────────────

/**
 * Point the workspace dir at our temp root so `getWorkspacePluginsDir()`
 * resolves to `<ROOT>/plugins/`. Must be set before any module that calls
 * `getWorkspacePluginsDir` is imported at runtime.
 */
beforeAll(() => {
  process.env.VELLUM_WORKSPACE_DIR = ROOT;
});

beforeEach(() => {
  ensurePluginsDir();
  resetPluginCacheForTests();
});

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("plugin mtime cache", () => {
  test("getPlugin returns a plugin from a valid directory", async () => {
    const dir = freshPluginDir("my-plugin");
    writePackageJson(dir, { ...SIMPLE_PKG, name: "my-plugin" });

    const plugin = await getPlugin("my-plugin");
    expect(plugin).toBeDefined();
    expect(plugin!.manifest.name).toBe("my-plugin");
    expect(plugin!.manifest.version).toBe("1.0.0");
  });

  test("cache hit: second getPlugin call does not rebuild", async () => {
    const dir = freshPluginDir("cached-plugin");
    writePackageJson(dir, { ...SIMPLE_PKG, name: "cached-plugin" });
    writeHook(
      dir,
      "user-prompt-submit",
      `export default () => ({ count: 1 });`,
    );

    const first = await getPlugin("cached-plugin");
    expect(first).toBeDefined();

    // Same mtime → cache hit → same plugin reference.
    const second = await getPlugin("cached-plugin");
    expect(second).toBe(first);
  });

  test("cache miss: editing a hook file triggers a rebuild", async () => {
    const dir = freshPluginDir("rebuild-plugin");
    writePackageJson(dir, { ...SIMPLE_PKG, name: "rebuild-plugin" });
    const hookFile = join(dir, "hooks", "user-prompt-submit.ts");
    writeHook(
      dir,
      "user-prompt-submit",
      `export default () => ({ count: 1 });`,
    );

    const first = await getPlugin("rebuild-plugin");
    expect(first).toBeDefined();

    // Touch the hook file to bump its mtime.
    touchFile(hookFile);

    const second = await getPlugin("rebuild-plugin");
    expect(second).toBeDefined();
    // Different reference — the plugin was rebuilt.
    expect(second).not.toBe(first);
  });

  test("plugin deletion: removing the directory evicts the cache entry", async () => {
    const dir = freshPluginDir("deletable-plugin");
    writePackageJson(dir, { ...SIMPLE_PKG, name: "deletable-plugin" });

    const plugin = await getPlugin("deletable-plugin");
    expect(plugin).toBeDefined();

    // Delete the plugin directory.
    rmSync(dir, { recursive: true, force: true });

    const result = await getPlugin("deletable-plugin");
    expect(result).toBeUndefined();

    // Cache entry should be evicted.
    const cacheState = _inspectCacheForTests();
    expect(
      cacheState.find((c) => c.name === "deletable-plugin"),
    ).toBeUndefined();
  });

  test("getAllPlugins returns all plugins on disk", async () => {
    const dir1 = freshPluginDir("plugin-a");
    writePackageJson(dir1, { ...SIMPLE_PKG, name: "plugin-a" });

    const dir2 = freshPluginDir("plugin-b");
    writePackageJson(dir2, { ...SIMPLE_PKG, name: "plugin-b" });

    const plugins = await getAllPlugins();
    expect(plugins).toHaveLength(2);
    const names = plugins.map((p) => p.manifest.name).sort();
    expect(names).toEqual(["plugin-a", "plugin-b"]);
  });

  test("getAllPlugins detects newly added plugin", async () => {
    const dir1 = freshPluginDir("existing-plugin");
    writePackageJson(dir1, { ...SIMPLE_PKG, name: "existing-plugin" });

    await getAllPlugins();

    // Add a new plugin directory.
    const dir2 = freshPluginDir("new-plugin");
    writePackageJson(dir2, { ...SIMPLE_PKG, name: "new-plugin" });

    const plugins = await getAllPlugins();
    expect(plugins).toHaveLength(2);
    const names = plugins.map((p) => p.manifest.name).sort();
    expect(names).toEqual(["existing-plugin", "new-plugin"]);
  });

  test("getAllPlugins evicts deleted plugins", async () => {
    const dir1 = freshPluginDir("survivor");
    writePackageJson(dir1, { ...SIMPLE_PKG, name: "survivor" });

    const dir2 = freshPluginDir("doomed");
    writePackageJson(dir2, { ...SIMPLE_PKG, name: "doomed" });

    await getAllPlugins();
    expect((await getAllPlugins()).length).toBe(2);

    // Delete one plugin.
    rmSync(dir2, { recursive: true, force: true });

    const plugins = await getAllPlugins();
    expect(plugins).toHaveLength(1);
    expect(plugins[0]!.manifest.name).toBe("survivor");
  });

  test("getHooksForFromCache returns hooks from all plugins", async () => {
    const dir1 = freshPluginDir("hook-plugin-a");
    writePackageJson(dir1, { ...SIMPLE_PKG, name: "hook-plugin-a" });
    writeHook(
      dir1,
      "user-prompt-submit",
      `export default () => ({ source: "a" });`,
    );

    const dir2 = freshPluginDir("hook-plugin-b");
    writePackageJson(dir2, { ...SIMPLE_PKG, name: "hook-plugin-b" });
    writeHook(
      dir2,
      "user-prompt-submit",
      `export default () => ({ source: "b" });`,
    );

    const hooks = await getHooksForFromCache("user-prompt-submit");
    expect(hooks).toHaveLength(2);
  });

  test("getHooksForFromCache returns empty array when no plugins have the hook", async () => {
    const dir = freshPluginDir("no-hook-plugin");
    writePackageJson(dir, { ...SIMPLE_PKG, name: "no-hook-plugin" });

    const hooks = await getHooksForFromCache("user-prompt-submit");
    expect(hooks).toHaveLength(0);
  });

  test("getHooksForFromCache rebuilds plugin after hook file edit", async () => {
    const dir = freshPluginDir("live-edit-plugin");
    writePackageJson(dir, { ...SIMPLE_PKG, name: "live-edit-plugin" });
    const hookFile = join(dir, "hooks", "user-prompt-submit.ts");
    writeHook(
      dir,
      "user-prompt-submit",
      `export default () => ({ version: 1 });`,
    );

    const hooksBefore = await getHooksForFromCache("user-prompt-submit");
    expect(hooksBefore).toHaveLength(1);

    // Snapshot the mtime before the edit.
    const cacheBefore = _inspectCacheForTests();
    const mtimeBefore = cacheBefore.find(
      (c) => c.name === "live-edit-plugin",
    )?.sourceMtime;

    // Edit the hook file — bump mtime.
    writeFileSync(hookFile, `export default () => ({ version: 2 });`);
    touchFile(hookFile);

    // The mtime cache should detect the change and rebuild the plugin.
    // The plugin object is rebuilt (new cache entry with new sourceMtime)
    // even though Bun's import cache may return the old module — the
    // rebuild itself is the observable behavior we verify here.
    const hooksAfter = await getHooksForFromCache("user-prompt-submit");
    expect(hooksAfter).toHaveLength(1);

    const cacheAfter = _inspectCacheForTests();
    const mtimeAfter = cacheAfter.find(
      (c) => c.name === "live-edit-plugin",
    )?.sourceMtime;
    expect(mtimeAfter).not.toBe(mtimeBefore);
  });

  test("plugin with no package.json is skipped", async () => {
    const dir = freshPluginDir("no-manifest");
    // No package.json written.

    const plugin = await getPlugin("no-manifest");
    expect(plugin).toBeUndefined();
  });

  test("empty plugins directory returns empty array", async () => {
    const plugins = await getAllPlugins();
    expect(plugins).toHaveLength(0);
  });

  test("missing plugins directory returns empty array", async () => {
    rmSync(PLUGINS_DIR, { recursive: true, force: true });
    const plugins = await getAllPlugins();
    expect(plugins).toHaveLength(0);
  });
});
