/**
 * Tests for the plugin cache orchestrator: boot discovery plus the
 * source-versions reconcile that drives every steady-state change.
 *
 * Each test materializes a synthetic plugin directory under a per-file
 * tempdir. Changes are published the way production publishes them — by
 * running the resource monitor's watcher pass over the same workspace — and
 * observed the way production observes them: a hook dispatch, whose
 * sentinel check applies the published diff. This makes the suite an
 * end-to-end exercise of detector → sentinel → reconcile → redeploy.
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
  createSourceWatchState,
  runSourceWatchPass,
  type SourceWatchState,
} from "../monitoring/plugin-source-watch.js";
import {
  _inspectToolCacheForTests,
  getCachedUserTools,
  getUserHooksFor,
  populateCacheAtBoot,
  resetPluginCacheForTests,
} from "../plugins/mtime-cache.js";
import { getSourceVersionsPath } from "../plugins/source-versions.js";
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

/**
 * Watcher state shared by a test's publishes, reset per test so each test's
 * first publish takes a fresh baseline (adopting any sentinel on disk).
 */
let watchState: SourceWatchState | null = null;

/** Strictly increasing mtime offset for sentinel touches within one test. */
let sentinelTouchSeq = 0;

/**
 * Publish pending source changes exactly the way production does: one pass
 * of the resource monitor's watcher over this workspace. When the pass
 * rewrites the sentinel, its mtime is bumped to a strictly increasing
 * timestamp so the daemon's one-stat gate observes every publish even when
 * two land inside the same filesystem-timestamp granule.
 */
function publishSourceChanges(): boolean {
  if (watchState === null) {
    watchState = createSourceWatchState();
  }
  const wrote = runSourceWatchPass(watchState);
  if (wrote) {
    touchFile(getSourceVersionsPath(), (sentinelTouchSeq += 2));
  }
  return wrote;
}

// ─── Setup / teardown ────────────────────────────────────────────────────────

beforeAll(() => {
  process.env.VELLUM_WORKSPACE_DIR = ROOT;
});

beforeEach(() => {
  ensurePluginsDir();
  ensureWorkspaceHooksDir();
  rmSync(getSourceVersionsPath(), { force: true });
  watchState = null;
  sentinelTouchSeq = 0;
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

  test("dispatch serves the cache and ignores disk changes until published", async () => {
    const dir = freshPluginDir("cached-plugin");
    writePackageJson(dir, { ...SIMPLE_PKG, name: "cached-plugin" });
    writeHook(dir, "user-prompt-submit", `export default () => "v1";`);

    await populateCacheAtBoot();
    const first = (await getUserHooksFor("user-prompt-submit"))[0];

    // Edit lands on disk but the watcher hasn't published — dispatch keeps
    // serving the exact cached function, proving it never re-scans.
    const hookFile = join(dir, "hooks", "user-prompt-submit.ts");
    writeFileSync(hookFile, `export default () => "v2";`);
    touchFile(hookFile);

    const again = (await getUserHooksFor("user-prompt-submit"))[0];
    expect(again).toBe(first!);
    expect((again as unknown as () => string)()).toBe("v1");
  });

  test("an edited hook takes effect once the watcher publishes", async () => {
    const dir = freshPluginDir("rebuild-plugin");
    writePackageJson(dir, { ...SIMPLE_PKG, name: "rebuild-plugin" });
    const hookFile = join(dir, "hooks", "user-prompt-submit.ts");
    writeHook(dir, "user-prompt-submit", `export default () => "v1";`);

    await populateCacheAtBoot();
    expect(
      (
        (
          await getUserHooksFor("user-prompt-submit")
        )[0] as unknown as () => string
      )(),
    ).toBe("v1");

    writeFileSync(hookFile, `export default () => "v2";`);
    touchFile(hookFile);
    expect(publishSourceChanges()).toBe(true);

    expect(
      (
        (
          await getUserHooksFor("user-prompt-submit")
        )[0] as unknown as () => string
      )(),
    ).toBe("v2");
  });

  test("plugin deletion: a published removal evicts cache entries", async () => {
    const dir = freshPluginDir("deletable-plugin");
    writePackageJson(dir, { ...SIMPLE_PKG, name: "deletable-plugin" });
    writeHook(
      dir,
      "user-prompt-submit",
      `export default () => ({ count: 1 });`,
    );

    await populateCacheAtBoot();
    expect(await getUserHooksFor("user-prompt-submit")).toHaveLength(1);

    rmSync(dir, { recursive: true, force: true });
    publishSourceChanges();

    const hooks = await getUserHooksFor("user-prompt-submit");
    expect(hooks).toHaveLength(0);

    expect(
      _inspectHookCacheForTests().find((key) =>
        key.startsWith("plugin:deletable-plugin/"),
      ),
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

  test("getUserHooksFor detects a newly added plugin once published", async () => {
    const dir1 = freshPluginDir("existing-plugin");
    writePackageJson(dir1, { ...SIMPLE_PKG, name: "existing-plugin" });
    writeHook(dir1, "user-prompt-submit", `export default () => ({ v: 1 });`);

    await populateCacheAtBoot();
    expect(await getUserHooksFor("user-prompt-submit")).toHaveLength(1);

    // Add a new plugin directory after boot and publish it.
    const dir2 = freshPluginDir("new-plugin");
    writePackageJson(dir2, { ...SIMPLE_PKG, name: "new-plugin" });
    writeHook(dir2, "user-prompt-submit", `export default () => ({ v: 2 });`);
    publishSourceChanges();

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

  test("an edited tool serves its new definition once published", async () => {
    const dir = freshPluginDir("tool-edit-plugin");
    writePackageJson(dir, { ...SIMPLE_PKG, name: "tool-edit-plugin" });
    // Unique tool name: the global tool registry is process-wide state that
    // survives the per-test cache reset, so a name shared with another test
    // would resolve to that test's stale registration.
    const toolFile = join(dir, "tools", "edited-tool.ts");
    writeTool(
      dir,
      "edited-tool",
      `export default { name: "edited-tool", description: "v1", parameters: { type: "object", properties: {} } };`,
    );

    await populateCacheAtBoot();
    expect(getCachedUserTools()[0]?.description).toBe("v1");

    writeFileSync(
      toolFile,
      `export default { name: "edited-tool", description: "v2", parameters: { type: "object", properties: {} } };`,
    );
    touchFile(toolFile);
    publishSourceChanges();
    await getUserHooksFor("user-prompt-submit");

    // Both the cache and the global registry serve the fresh definition —
    // the redeploy unregistered the old tool and registered the new one.
    expect(getCachedUserTools()[0]?.description).toBe("v2");
    expect(
      getAllToolDefinitions().find((t) => t.name === "edited-tool")
        ?.description,
    ).toBe("v2");
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

  test("a plugin named like the workspace owner does not collide with it", async () => {
    // Load-time discovery doesn't reject a plugin whose manifest name equals
    // the synthetic workspace owner. The cache key is scoped by owner kind, so
    // `plugin:__workspace__/…` and `workspace:__workspace__/…` stay distinct
    // and both hooks run. The install slug (directory basename) equals the
    // manifest name, as the installer enforces — that's what makes the plugin's
    // hooks resolve at `<plugins>/__workspace__/hooks` while the workspace
    // owner's resolve at `<workspace>/hooks`, distinct directories.
    const dir = freshPluginDir("__workspace__");
    writePackageJson(dir, { ...SIMPLE_PKG, name: "__workspace__" });
    writeHook(
      dir,
      "pre-model-call",
      `export default () => ({ from: "plugin" });`,
    );
    writeWorkspaceHook(
      "pre-model-call",
      `export default () => ({ from: "workspace" });`,
    );

    await populateCacheAtBoot();

    const hooks = await getUserHooksFor("pre-model-call");
    expect(hooks).toHaveLength(2);
    const froms = hooks.map(
      (fn) => (fn as unknown as () => { from: string })().from,
    );
    // Plugin runs first (install-date order), workspace last.
    expect(froms).toEqual(["plugin", "workspace"]);
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

  test("an edited workspace hook takes effect once published", async () => {
    const hookFile = join(WORKSPACE_HOOKS_DIR, "post-model-call.ts");
    writeWorkspaceHook("post-model-call", `export default () => "ws-v1";`);

    await populateCacheAtBoot();
    expect(
      (
        (await getUserHooksFor("post-model-call"))[0] as unknown as () => string
      )(),
    ).toBe("ws-v1");

    writeFileSync(hookFile, `export default () => "ws-v2";`);
    touchFile(hookFile);
    publishSourceChanges();

    expect(
      (
        (await getUserHooksFor("post-model-call"))[0] as unknown as () => string
      )(),
    ).toBe("ws-v2");
  });

  test("deleting a workspace hook file evicts it once published", async () => {
    const hookFile = join(WORKSPACE_HOOKS_DIR, "stop.ts");
    writeWorkspaceHook("stop", `export default () => ({ v: 1 });`);

    await populateCacheAtBoot();
    expect(await getUserHooksFor("stop")).toHaveLength(1);

    rmSync(hookFile, { force: true });
    publishSourceChanges();

    const hooks = await getUserHooksFor("stop");
    expect(hooks).toHaveLength(0);
  });

  test("a newly added workspace hook is picked up once published", async () => {
    await populateCacheAtBoot();
    expect(await getUserHooksFor("post-compact")).toHaveLength(0);

    writeWorkspaceHook("post-compact", `export default () => ({ v: 1 });`);
    publishSourceChanges();

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
 * Publish pending source changes through the watcher, then dispatch — the
 * production sequence: the monitor's pass rewrites the sentinel, and the
 * next hook dispatch's one-stat gate applies the diff. The hook name is
 * irrelevant — the reconcile runs regardless of whether a plugin defines
 * that hook.
 */
async function publishAndDispatch(): Promise<void> {
  publishSourceChanges();
  await getUserHooksFor("user-prompt-submit");
}

describe("plugin runtime activation", () => {
  test("a plugin installed after boot becomes live once published", async () => {
    await populateCacheAtBoot(); // empty plugins dir
    expect(getAllToolDefinitions().some((t) => t.name === "late-tool")).toBe(
      false,
    );

    const dir = freshPluginDir("late-plugin");
    writePackageJson(dir, { ...SIMPLE_PKG, name: "late-plugin" });
    writeTool(dir, "late-tool", TOOL_SRC("late-tool"));
    const initMarker = join(ROOT, "late-init.log");
    writeMarkerHook(dir, "init", initMarker, "init");

    await publishAndDispatch();

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

  test("activation is idempotent — republishing without changes does not re-run init", async () => {
    const dir = freshPluginDir("idem-plugin");
    writePackageJson(dir, { ...SIMPLE_PKG, name: "idem-plugin" });
    writeTool(dir, "idem-tool", TOOL_SRC("idem-tool"));
    const initMarker = join(ROOT, "idem-init.log");
    writeMarkerHook(dir, "init", initMarker, "init");

    await populateCacheAtBoot();
    await publishAndDispatch();
    await publishAndDispatch();

    expect(readFileSync(initMarker, "utf8").trim().split("\n")).toHaveLength(1);
    // Registered exactly once (no refcount inflation from re-registration).
    expect(getToolOwner("idem-tool")).toEqual({
      kind: "plugin",
      id: "idem-plugin",
    });
  });

  test("an out-of-band directory removal unregisters tools but runs no shutdown", async () => {
    // A raw `rm` (bypassing the managed uninstall) is only noticed by the
    // monitor after the files are gone, so there's no `shutdown` to resolve —
    // the reconcile just evicts. A managed uninstall runs `shutdown` before
    // removal (see uninstall-plugin.test.ts).
    const dir = freshPluginDir("temp-plugin");
    writePackageJson(dir, { ...SIMPLE_PKG, name: "temp-plugin" });
    writeTool(dir, "temp-tool", TOOL_SRC("temp-tool"));
    const shutdownMarker = join(ROOT, "temp-shutdown.log");
    writeMarkerHook(dir, "shutdown", shutdownMarker, "bye");

    await populateCacheAtBoot();
    expect(getToolOwner("temp-tool")?.kind).toBe("plugin");

    rmSync(dir, { recursive: true, force: true });
    await publishAndDispatch();

    expect(getToolOwner("temp-tool")).toBeUndefined();
    expect(getPluginToolDefinitions().some((t) => t.name === "temp-tool")).toBe(
      false,
    );
    expect(existsSync(shutdownMarker)).toBe(false);
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

  test("disabling a plugin at runtime tears down its tools and runs shutdown", async () => {
    const dir = freshPluginDir("disable-plugin");
    writePackageJson(dir, { ...SIMPLE_PKG, name: "disable-plugin" });
    writeTool(dir, "disable-tool", TOOL_SRC("disable-tool"));
    const shutdownMarker = join(ROOT, "disable-shutdown.log");
    writeMarkerHook(dir, "shutdown", shutdownMarker, "disabled");

    await populateCacheAtBoot();
    expect(getToolOwner("disable-tool")?.kind).toBe("plugin");

    writeFileSync(join(dir, ".disabled"), "");
    await publishAndDispatch();

    expect(getToolOwner("disable-tool")).toBeUndefined();
    // Disable keeps the directory, so `shutdown` is resolved from disk and runs
    // even though it was never pre-warmed.
    expect(existsSync(shutdownMarker)).toBe(true);
  });
});

// ─── Live reload (sentinel-driven redeploy) ──────────────────────────────────

/** Write a helper module at `relPath` inside a plugin dir. */
function writeLibFile(dir: string, relPath: string, body: string): string {
  const path = join(dir, relPath);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, body);
  return path;
}

/** Dispatch `hookName` and return the single expected hook's result. */
async function dispatchFirst(hookName: string): Promise<unknown> {
  const hooks = await getUserHooksFor(hookName);
  expect(hooks).toHaveLength(1);
  return (hooks[0] as unknown as () => unknown)();
}

describe("live reload (sentinel-driven redeploy)", () => {
  test("editing a helper imported by a hook redeploys the plugin, repeatably", async () => {
    const dir = freshPluginDir("helper-plugin");
    writePackageJson(dir, { ...SIMPLE_PKG, name: "helper-plugin" });
    const helperPath = writeLibFile(
      dir,
      join("lib", "helper.ts"),
      `export const value = "v1";`,
    );
    writeHook(
      dir,
      "helper-reload",
      `import { value } from "../lib/helper.ts";\nexport default () => value;`,
    );

    await populateCacheAtBoot();
    expect(await dispatchFirst("helper-reload")).toBe("v1");

    // Only the helper changes — the hook file's own mtime never moves, so
    // any per-entry-file scheme would keep serving v1 here. And a reloaded
    // plugin must itself stay reloadable.
    for (const marker of ["v2", "v3"]) {
      writeFileSync(
        helperPath,
        `export const value = ${JSON.stringify(marker)};`,
      );
      touchFile(helperPath, sentinelTouchSeq + 2);
      publishSourceChanges();
      expect(await dispatchFirst("helper-reload")).toBe(marker);
    }
  });

  test("editing a transitive helper (hook → a → b) redeploys consistently", async () => {
    const dir = freshPluginDir("transitive-plugin");
    writePackageJson(dir, { ...SIMPLE_PKG, name: "transitive-plugin" });
    const bPath = writeLibFile(
      dir,
      join("lib", "b.ts"),
      `export const leaf = "b1";`,
    );
    writeLibFile(
      dir,
      join("lib", "a.ts"),
      `import { leaf } from "./b.ts";\nexport const mid = "a:" + leaf;`,
    );
    writeHook(
      dir,
      "transitive-reload",
      `import { mid } from "../lib/a.ts";\nexport default () => mid;`,
    );

    await populateCacheAtBoot();
    expect(await dispatchFirst("transitive-reload")).toBe("a:b1");

    // The intermediate module `a` is untouched. Whole-plugin eviction is
    // what keeps a re-imported hook from pairing with a's stale cached
    // binding to the old `b`.
    writeFileSync(bPath, `export const leaf = "b2";`);
    touchFile(bPath, sentinelTouchSeq + 2);
    publishSourceChanges();
    expect(await dispatchFirst("transitive-reload")).toBe("a:b2");
  });

  test("a reload runs the plugin's shutdown (reason: reload) and the new init", async () => {
    const dir = freshPluginDir("lifecycle-plugin");
    writePackageJson(dir, { ...SIMPLE_PKG, name: "lifecycle-plugin" });
    const helperPath = writeLibFile(
      dir,
      join("lib", "helper.ts"),
      `export const value = 1;`,
    );
    const initMarker = join(ROOT, "reload-init.log");
    const shutdownMarker = join(ROOT, "reload-shutdown.log");
    rmSync(initMarker, { force: true });
    rmSync(shutdownMarker, { force: true });
    writeMarkerHook(dir, "init", initMarker, "init");
    writeHook(
      dir,
      "shutdown",
      `import { appendFileSync } from "node:fs";\nexport default (ctx: { reason: string }) => { appendFileSync(${JSON.stringify(shutdownMarker)}, ctx.reason + "\\n"); };`,
    );

    await populateCacheAtBoot();
    expect(readFileSync(initMarker, "utf8").trim().split("\n")).toHaveLength(1);
    expect(existsSync(shutdownMarker)).toBe(false);

    // Edit a helper (not shutdown.ts) so the reload resolves the unchanged
    // shutdown from disk and runs it, then brings the new version up through
    // the same init path as boot.
    writeFileSync(helperPath, `export const value = 2;`);
    touchFile(helperPath, sentinelTouchSeq + 2);
    await publishAndDispatch();

    expect(readFileSync(shutdownMarker, "utf8").trim().split("\n")).toEqual([
      "reload",
    ]);
    expect(readFileSync(initMarker, "utf8").trim().split("\n")).toHaveLength(2);
  });

  test("boot adopts a pre-existing sentinel without spurious redeploys", async () => {
    const dir = freshPluginDir("adopt-plugin");
    writePackageJson(dir, { ...SIMPLE_PKG, name: "adopt-plugin" });
    writeLibFile(dir, join("lib", "helper.ts"), `export const v = 1;`);
    const initMarker = join(ROOT, "adopt-init.log");
    rmSync(initMarker, { force: true });
    writeMarkerHook(dir, "init", initMarker, "init");

    // The watcher published before the daemon booted.
    publishSourceChanges();

    await populateCacheAtBoot();
    await getUserHooksFor("user-prompt-submit");
    await getUserHooksFor("user-prompt-submit");

    // One init: the sentinel matching boot's own walk must not redeploy.
    expect(readFileSync(initMarker, "utf8").trim().split("\n")).toHaveLength(1);
  });
});

describe("sentinel path validation (ATL-983)", () => {
  test("forged sentinel pointing outside plugins dir does not load arbitrary code", async () => {
    // Create a directory outside the plugins dir that looks like a plugin.
    const evilDir = join(ROOT, "evil-outside-plugins");
    mkdirSync(evilDir, { recursive: true });
    writePackageJson(evilDir, { ...SIMPLE_PKG, name: "evil-plugin" });
    const evilMarker = join(ROOT, "evil-init.log");
    rmSync(evilMarker, { force: true });
    writeMarkerHook(evilDir, "init", evilMarker, "init");

    // Forge a sentinel that claims the evil directory is a plugin.
    const sentinelPath = getSourceVersionsPath();
    const { snapshotPluginSource } =
      await import("../plugins/source-fingerprint.js");
    const snapshot = snapshotPluginSource(evilDir);
    writeFileSync(
      sentinelPath,
      JSON.stringify({
        format: 1,
        generation: 1,
        writtenAt: new Date().toISOString(),
        plugins: {
          [evilDir]: {
            fingerprint: snapshot.fingerprint,
            evictionPaths: snapshot.evictionPaths,
            disabled: false,
          },
        },
      }),
    );
    // Bump mtime so the sentinel check picks it up.
    const future = new Date(Date.now() + 5000);
    utimesSync(sentinelPath, future, future);

    await getUserHooksFor("user-prompt-submit");

    // The evil plugin's init hook must NOT have run.
    expect(existsSync(evilMarker)).toBe(false);
  });
});
