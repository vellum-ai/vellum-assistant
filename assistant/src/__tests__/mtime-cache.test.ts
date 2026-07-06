/**
 * Tests for the per-surface mtime cache — the pull-based replacement for
 * PluginSourceWatcher.
 *
 * Each test materializes a synthetic plugin directory under a per-file
 * tempdir, then exercises observable behavior: cache hit (same mtime),
 * cache miss (changed mtime → re-import), plugin deletion (eviction),
 * and hook collection across multiple plugins.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
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

import { _inspectHookCacheForTests } from "../hooks/hook-loader.js";
import {
  _inspectToolCacheForTests,
  getCachedUserTools,
  getUserHooksFor,
  populateCacheAtBoot,
  resetPluginCacheForTests,
} from "../plugins/mtime-cache.js";
import {
  getAllToolDefinitions,
  getPluginToolDefinitions,
  getToolOwner,
} from "../tools/registry.js";

// ─── Test fixtures ───────────────────────────────────────────────────────────

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

function writeInstallMeta(dir: string, installedAt: string): void {
  writeFileSync(
    join(dir, "install-meta.json"),
    JSON.stringify(
      {
        name: "test",
        installedAt,
        source: { kind: "github", owner: "test", repo: "test", ref: "main" },
      },
      null,
      2,
    ),
  );
}

function writeTool(dir: string, toolName: string, body: string): void {
  const toolsDir = join(dir, "tools");
  mkdirSync(toolsDir, { recursive: true });
  writeFileSync(join(toolsDir, `${toolName}.ts`), body);
}

/** The standalone workspace hooks directory (`<workspace>/hooks/`). */
const WORKSPACE_HOOKS_DIR = join(ROOT, "hooks");

function ensureWorkspaceHooksDir(): void {
  rmSync(WORKSPACE_HOOKS_DIR, { recursive: true, force: true });
  mkdirSync(WORKSPACE_HOOKS_DIR, { recursive: true });
}

/** Write a standalone hook file directly under `<workspace>/hooks/`. */
function writeWorkspaceHook(hookName: string, body: string): void {
  mkdirSync(WORKSPACE_HOOKS_DIR, { recursive: true });
  writeFileSync(join(WORKSPACE_HOOKS_DIR, `${hookName}.ts`), body);
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

beforeAll(() => {
  process.env.VELLUM_WORKSPACE_DIR = ROOT;
});

beforeEach(() => {
  ensurePluginsDir();
  ensureWorkspaceHooksDir();
  resetPluginCacheForTests();
});

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("plugin mtime cache (per-surface)", () => {
  test("populateCacheAtBoot discovers and caches hooks", async () => {
    const dir = freshPluginDir("hook-plugin");
    writePackageJson(dir, { ...SIMPLE_PKG, name: "hook-plugin" });
    writeHook(
      dir,
      "user-prompt-submit",
      `export default () => ({ count: 1 });`,
    );

    await populateCacheAtBoot();

    const hooks = await getUserHooksFor("user-prompt-submit");
    expect(hooks).toHaveLength(1);
  });

  test("cache hit: same mtime does not re-import", async () => {
    const dir = freshPluginDir("cached-plugin");
    writePackageJson(dir, { ...SIMPLE_PKG, name: "cached-plugin" });
    writeHook(
      dir,
      "user-prompt-submit",
      `export default () => ({ count: 1 });`,
    );

    await populateCacheAtBoot();

    const cacheBefore = _inspectHookCacheForTests();
    expect(cacheBefore).toHaveLength(1);

    // Read again — same mtime, no re-import.
    await getUserHooksFor("user-prompt-submit");

    const cacheAfter = _inspectHookCacheForTests();
    expect(cacheAfter).toHaveLength(1);
    expect(cacheAfter[0]?.sourceMtime).toBe(cacheBefore[0]?.sourceMtime);
  });

  test("cache miss: editing a hook file triggers re-import", async () => {
    const dir = freshPluginDir("rebuild-plugin");
    writePackageJson(dir, { ...SIMPLE_PKG, name: "rebuild-plugin" });
    const hookFile = join(dir, "hooks", "user-prompt-submit.ts");
    writeHook(
      dir,
      "user-prompt-submit",
      `export default () => ({ count: 1 });`,
    );

    await populateCacheAtBoot();

    const mtimeBefore = _inspectHookCacheForTests()[0]?.sourceMtime;

    // Touch the hook file to bump its mtime.
    touchFile(hookFile);

    // Read again — mtime changed, re-import.
    await getUserHooksFor("user-prompt-submit");

    const mtimeAfter = _inspectHookCacheForTests()[0]?.sourceMtime;
    expect(mtimeAfter).not.toBe(mtimeBefore);
  });

  test("plugin deletion: removing directory evicts cache entries", async () => {
    const dir = freshPluginDir("deletable-plugin");
    writePackageJson(dir, { ...SIMPLE_PKG, name: "deletable-plugin" });
    writeHook(
      dir,
      "user-prompt-submit",
      `export default () => ({ count: 1 });`,
    );

    await populateCacheAtBoot();
    expect(await getUserHooksFor("user-prompt-submit")).toHaveLength(1);

    // Delete the plugin directory.
    rmSync(dir, { recursive: true, force: true });

    // Read again — plugin gone, hooks evicted.
    const hooks = await getUserHooksFor("user-prompt-submit");
    expect(hooks).toHaveLength(0);

    const cacheState = _inspectHookCacheForTests();
    expect(
      cacheState.find((c) => c.key.startsWith("deletable-plugin/")),
    ).toBeUndefined();
  });

  test("getUserHooksFor returns hooks from all plugins", async () => {
    const dir1 = freshPluginDir("plugin-a");
    writePackageJson(dir1, { ...SIMPLE_PKG, name: "plugin-a" });
    writeHook(
      dir1,
      "user-prompt-submit",
      `export default () => ({ source: "a" });`,
    );

    const dir2 = freshPluginDir("plugin-b");
    writePackageJson(dir2, { ...SIMPLE_PKG, name: "plugin-b" });
    writeHook(
      dir2,
      "user-prompt-submit",
      `export default () => ({ source: "b" });`,
    );

    await populateCacheAtBoot();

    const hooks = await getUserHooksFor("user-prompt-submit");
    expect(hooks).toHaveLength(2);
  });

  test("getUserHooksFor returns empty array when no plugins have the hook", async () => {
    const dir = freshPluginDir("no-hook-plugin");
    writePackageJson(dir, { ...SIMPLE_PKG, name: "no-hook-plugin" });

    await populateCacheAtBoot();

    const hooks = await getUserHooksFor("user-prompt-submit");
    expect(hooks).toHaveLength(0);
  });

  test("getUserHooksFor detects newly added plugin without restart", async () => {
    const dir1 = freshPluginDir("existing-plugin");
    writePackageJson(dir1, { ...SIMPLE_PKG, name: "existing-plugin" });
    writeHook(dir1, "user-prompt-submit", `export default () => ({ v: 1 });`);

    await populateCacheAtBoot();
    expect(await getUserHooksFor("user-prompt-submit")).toHaveLength(1);

    // Add a new plugin directory after boot.
    const dir2 = freshPluginDir("new-plugin");
    writePackageJson(dir2, { ...SIMPLE_PKG, name: "new-plugin" });
    writeHook(dir2, "user-prompt-submit", `export default () => ({ v: 2 });`);

    // The next read should pick it up.
    const hooks = await getUserHooksFor("user-prompt-submit");
    expect(hooks).toHaveLength(2);
  });

  test("tools are cached and returned via getCachedUserTools", async () => {
    const dir = freshPluginDir("tool-plugin");
    writePackageJson(dir, { ...SIMPLE_PKG, name: "tool-plugin" });
    writeTool(
      dir,
      "my-tool",
      `export default { name: "my-tool", description: "test", parameters: { type: "object", properties: {} } };`,
    );

    await populateCacheAtBoot();

    const tools = getCachedUserTools();
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe("my-tool");
  });

  test("editing a tool file triggers re-import on next scan", async () => {
    const dir = freshPluginDir("tool-edit-plugin");
    writePackageJson(dir, { ...SIMPLE_PKG, name: "tool-edit-plugin" });
    const toolFile = join(dir, "tools", "my-tool.ts");
    writeTool(
      dir,
      "my-tool",
      `export default { name: "my-tool", description: "v1", parameters: { type: "object", properties: {} } };`,
    );

    await populateCacheAtBoot();

    const mtimeBefore = _inspectToolCacheForTests()[0]?.sourceMtime;

    // Edit the tool file and bump mtime.
    writeFileSync(
      toolFile,
      `export default { name: "my-tool", description: "v2", parameters: { type: "object", properties: {} } };`,
    );
    touchFile(toolFile);

    // Trigger a scan by calling getUserHooksFor (which calls scanPlugins).
    await getUserHooksFor("user-prompt-submit");

    const mtimeAfter = _inspectToolCacheForTests()[0]?.sourceMtime;
    expect(mtimeAfter).not.toBe(mtimeBefore);
  });

  test("plugin with no package.json is skipped", async () => {
    freshPluginDir("no-manifest");
    // No package.json written.

    await populateCacheAtBoot();

    const hooks = await getUserHooksFor("user-prompt-submit");
    expect(hooks).toHaveLength(0);
  });

  test("empty plugins directory returns empty arrays", async () => {
    await populateCacheAtBoot();
    expect(await getUserHooksFor("user-prompt-submit")).toHaveLength(0);
    expect(getCachedUserTools()).toHaveLength(0);
  });

  test("missing plugins directory returns empty arrays", async () => {
    rmSync(PLUGINS_DIR, { recursive: true, force: true });
    await populateCacheAtBoot();
    expect(await getUserHooksFor("user-prompt-submit")).toHaveLength(0);
    expect(getCachedUserTools()).toHaveLength(0);
  });

  test("hooks are ordered by install-meta.json installedAt", async () => {
    // Create two plugins with different install dates. The one installed
    // later (newer timestamp) should appear second in hook execution order.
    const dirA = freshPluginDir("plugin-alpha");
    writePackageJson(dirA, { ...SIMPLE_PKG, name: "plugin-alpha" });
    writeHook(
      dirA,
      "user-prompt-submit",
      `export default () => ({ tag: "alpha" });`,
    );
    writeInstallMeta(dirA, "2026-01-15T00:00:00.000Z");

    const dirB = freshPluginDir("plugin-beta");
    writePackageJson(dirB, { ...SIMPLE_PKG, name: "plugin-beta" });
    writeHook(
      dirB,
      "user-prompt-submit",
      `export default () => ({ tag: "beta" });`,
    );
    writeInstallMeta(dirB, "2026-01-01T00:00:00.000Z"); // earlier install

    await populateCacheAtBoot();

    const hooks = await getUserHooksFor("user-prompt-submit");
    expect(hooks).toHaveLength(2);

    // beta was installed earlier (Jan 1) so it should come first.
    const results = hooks.map((fn) =>
      (fn as unknown as () => { tag: string })(),
    );
    expect(results[0]!.tag).toBe("beta");
    expect(results[1]!.tag).toBe("alpha");
  });

  test("plugin without install-meta.json sorts after dated plugins", async () => {
    const dirDated = freshPluginDir("dated-plugin");
    writePackageJson(dirDated, { ...SIMPLE_PKG, name: "dated-plugin" });
    writeHook(
      dirDated,
      "user-prompt-submit",
      `export default () => ({ tag: "dated" });`,
    );
    writeInstallMeta(dirDated, "2026-01-01T00:00:00.000Z");

    const dirUndated = freshPluginDir("undated-plugin");
    writePackageJson(dirUndated, { ...SIMPLE_PKG, name: "undated-plugin" });
    writeHook(
      dirUndated,
      "user-prompt-submit",
      `export default () => ({ tag: "undated" });`,
    );
    // No install-meta.json — falls back to birthtime, which is "now"
    // (later than the dated plugin's Jan 1 install date).

    await populateCacheAtBoot();

    const hooks = await getUserHooksFor("user-prompt-submit");
    expect(hooks).toHaveLength(2);

    const results = hooks.map((fn) =>
      (fn as unknown as () => { tag: string })(),
    );
    expect(results[0]!.tag).toBe("dated");
    expect(results[1]!.tag).toBe("undated");
  });
});

describe("workspace hooks (<workspace>/hooks/)", () => {
  test("getUserHooksFor loads a standalone workspace hook", async () => {
    writeWorkspaceHook(
      "user-prompt-submit",
      `export default () => ({ ws: 1 });`,
    );

    await populateCacheAtBoot();

    const hooks = await getUserHooksFor("user-prompt-submit");
    expect(hooks).toHaveLength(1);
  });

  test("workspace hooks load even when no plugins directory exists", async () => {
    rmSync(PLUGINS_DIR, { recursive: true, force: true });
    writeWorkspaceHook("post-tool-use", `export default () => ({ ws: 1 });`);

    await populateCacheAtBoot();

    const hooks = await getUserHooksFor("post-tool-use");
    expect(hooks).toHaveLength(1);
    expect(getCachedUserTools()).toHaveLength(0);
  });

  // NB: each test below uses a distinct hook event name so the workspace
  // hook file path is unique and each test stays independent of the cache
  // state its siblings leave behind (the plugin tests get the same isolation
  // from a fresh plugin directory per test).
  test("plugin hooks run before the workspace hook for the same event", async () => {
    const dir = freshPluginDir("ordering-plugin");
    writePackageJson(dir, { ...SIMPLE_PKG, name: "ordering-plugin" });
    writeHook(
      dir,
      "pre-model-call",
      `export default () => ({ tag: "plugin" });`,
    );
    writeWorkspaceHook(
      "pre-model-call",
      `export default () => ({ tag: "workspace" });`,
    );

    await populateCacheAtBoot();

    const hooks = await getUserHooksFor("pre-model-call");
    expect(hooks).toHaveLength(2);
    const results = hooks.map((fn) =>
      (fn as unknown as () => { tag: string })(),
    );
    expect(results[0]!.tag).toBe("plugin");
    expect(results[1]!.tag).toBe("workspace");
  });

  test("editing a workspace hook file triggers re-import", async () => {
    const hookFile = join(WORKSPACE_HOOKS_DIR, "post-model-call.ts");
    writeWorkspaceHook("post-model-call", `export default () => ({ v: 1 });`);

    await populateCacheAtBoot();

    const before = _inspectHookCacheForTests().find((c) =>
      c.key.startsWith("__workspace__/"),
    );
    expect(before).toBeDefined();

    touchFile(hookFile);
    await getUserHooksFor("post-model-call");

    const after = _inspectHookCacheForTests().find((c) =>
      c.key.startsWith("__workspace__/"),
    );
    expect(after?.sourceMtime).not.toBe(before?.sourceMtime);
  });

  test("deleting a workspace hook file evicts it on next read", async () => {
    const hookFile = join(WORKSPACE_HOOKS_DIR, "stop.ts");
    writeWorkspaceHook("stop", `export default () => ({ v: 1 });`);

    await populateCacheAtBoot();
    expect(await getUserHooksFor("stop")).toHaveLength(1);

    rmSync(hookFile, { force: true });

    const hooks = await getUserHooksFor("stop");
    expect(hooks).toHaveLength(0);
  });

  test("a newly added workspace hook is picked up without restart", async () => {
    await populateCacheAtBoot();
    expect(await getUserHooksFor("post-compact")).toHaveLength(0);

    writeWorkspaceHook("post-compact", `export default () => ({ v: 1 });`);

    expect(await getUserHooksFor("post-compact")).toHaveLength(1);
  });

  test("a workspace init hook runs once at boot", async () => {
    // The init hook writes a sentinel file so we can observe it ran exactly
    // once during populateCacheAtBoot.
    const sentinel = join(ROOT, "ws-init-ran.txt");
    rmSync(sentinel, { force: true });
    writeWorkspaceHook(
      "init",
      `import { appendFileSync } from "node:fs";
       export default () => { appendFileSync(${JSON.stringify(sentinel)}, "x"); };`,
    );

    await populateCacheAtBoot();

    const { readFileSync: rf, existsSync: ex } = await import("node:fs");
    expect(ex(sentinel)).toBe(true);
    expect(rf(sentinel, "utf8")).toBe("x");
  });
});

// ─── Runtime activation (hot-reload without a daemon restart) ──────────────────

/**
 * Write a hook that appends `token` to `markerPath` each time it runs, so a
 * test can count how many times `init`/`shutdown` fired.
 */
function writeMarkerHook(
  dir: string,
  hookName: string,
  markerPath: string,
  token: string,
): void {
  writeHook(
    dir,
    hookName,
    `import { appendFileSync } from "node:fs";\nexport default () => { appendFileSync(${JSON.stringify(markerPath)}, ${JSON.stringify(`${token}\n`)}); };`,
  );
}

const TOOL_SRC = (name: string) =>
  `export default { name: ${JSON.stringify(name)}, description: "test", parameters: { type: "object", properties: {} } };`;

/**
 * Simulate the per-turn plugin hook dispatch that drives runtime reconciliation
 * in production: any `getUserHooksFor` call runs `scanPlugins`, which activates
 * newly present plugins and deactivates removed ones. The hook name is
 * irrelevant — the scan runs regardless of whether a plugin defines that hook.
 */
async function triggerScan(): Promise<void> {
  await getUserHooksFor("user-prompt-submit");
}

describe("plugin runtime activation", () => {
  test("a plugin installed after boot becomes live on the next scan", async () => {
    await populateCacheAtBoot(); // empty plugins dir
    expect(getAllToolDefinitions().some((t) => t.name === "late-tool")).toBe(
      false,
    );

    const dir = freshPluginDir("late-plugin");
    writePackageJson(dir, { ...SIMPLE_PKG, name: "late-plugin" });
    writeTool(dir, "late-tool", TOOL_SRC("late-tool"));
    const initMarker = join(ROOT, "late-init.log");
    writeMarkerHook(dir, "init", initMarker, "init");

    await triggerScan();

    // Registered into the global registry as a plugin-owned tool, and exposed
    // to the per-turn resolver via getPluginToolDefinitions().
    expect(getToolOwner("late-tool")).toEqual({
      kind: "plugin",
      id: "late-plugin",
    });
    expect(getAllToolDefinitions().some((t) => t.name === "late-tool")).toBe(
      true,
    );
    expect(getPluginToolDefinitions().some((t) => t.name === "late-tool")).toBe(
      true,
    );
    // init ran exactly once.
    expect(readFileSync(initMarker, "utf8").trim().split("\n")).toHaveLength(1);
  });

  test("activation is idempotent — repeated scans do not re-run init", async () => {
    const dir = freshPluginDir("idem-plugin");
    writePackageJson(dir, { ...SIMPLE_PKG, name: "idem-plugin" });
    writeTool(dir, "idem-tool", TOOL_SRC("idem-tool"));
    const initMarker = join(ROOT, "idem-init.log");
    writeMarkerHook(dir, "init", initMarker, "init");

    await populateCacheAtBoot();
    await triggerScan();
    await triggerScan();

    expect(readFileSync(initMarker, "utf8").trim().split("\n")).toHaveLength(1);
    // Registered exactly once (no refcount inflation from re-registration).
    expect(getToolOwner("idem-tool")).toEqual({
      kind: "plugin",
      id: "idem-plugin",
    });
  });

  test("removing a plugin directory deactivates it (unregister + shutdown)", async () => {
    const dir = freshPluginDir("temp-plugin");
    writePackageJson(dir, { ...SIMPLE_PKG, name: "temp-plugin" });
    writeTool(dir, "temp-tool", TOOL_SRC("temp-tool"));
    const shutdownMarker = join(ROOT, "temp-shutdown.log");
    writeMarkerHook(dir, "shutdown", shutdownMarker, "bye");

    await populateCacheAtBoot();
    expect(getToolOwner("temp-tool")?.kind).toBe("plugin");

    rmSync(dir, { recursive: true, force: true });
    await triggerScan();

    expect(getToolOwner("temp-tool")).toBeUndefined();
    expect(getPluginToolDefinitions().some((t) => t.name === "temp-tool")).toBe(
      false,
    );
    expect(existsSync(shutdownMarker)).toBe(true);
  });

  test("a user plugin's shutdown hook is surfaced through the unified hook lookup", async () => {
    // Plugin `shutdown` hooks fire at daemon shutdown through the same
    // getHooksFor/runHook pipeline as every other lifecycle hook. Prove the
    // user-land side is discoverable that way: the plugin's shutdown hook is
    // returned by the unified per-name lookup and runs when invoked.
    const dir = freshPluginDir("shutdown-hook-plugin");
    writePackageJson(dir, { ...SIMPLE_PKG, name: "shutdown-hook-plugin" });
    const shutdownMarker = join(ROOT, "user-shutdown.log");
    writeMarkerHook(dir, "shutdown", shutdownMarker, "bye");

    await populateCacheAtBoot();

    const shutdownHooks = await getUserHooksFor("shutdown");
    expect(shutdownHooks).toHaveLength(1);

    await shutdownHooks[0]!({ assistantVersion: "test", reason: "shutdown" });
    expect(existsSync(shutdownMarker)).toBe(true);
  });

  test("disabling a plugin at runtime tears down its tools", async () => {
    const dir = freshPluginDir("disable-plugin");
    writePackageJson(dir, { ...SIMPLE_PKG, name: "disable-plugin" });
    writeTool(dir, "disable-tool", TOOL_SRC("disable-tool"));

    await populateCacheAtBoot();
    expect(getToolOwner("disable-tool")?.kind).toBe("plugin");

    writeFileSync(join(dir, ".disabled"), "");
    await triggerScan();

    expect(getToolOwner("disable-tool")).toBeUndefined();
  });
});
