/**
 * Tests for plugin-declared credential key pattern contributions.
 *
 * A plugin may declare `credentialKeyPatterns` in its `package.json` manifest;
 * the plugin lifecycle registers the declared patterns into the secret-pattern
 * registry when the plugin activates and removes them on every teardown path
 * (disable, uninstall, eviction). Assertions read the registry via
 * {@link getPluginSecretPatterns} — end-to-end detection through the ingress /
 * scanner / redaction consumers is covered by those consumers' own suites.
 *
 * Two lifecycle layers are exercised, mirroring the injector-contribution
 * suite (`plugin-injector-contribution.test.ts`) and the mtime-cache suite
 * (`mtime-cache.test.ts`):
 *
 *  1. User plugins — synthetic plugin directories driven through boot
 *     discovery and the source-versions reconcile (install, disable,
 *     uninstall published exactly the way production publishes them).
 *  2. Default/registered plugins — `bootstrapPlugins()` registering the
 *     manifest declaration and rolling it back when `init()` fails.
 *
 * All token shapes in this file are synthetic; no real credential formats.
 */

import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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

import { bootstrapPlugins } from "../daemon/external-plugins-bootstrap.js";
import {
  createSourceWatchState,
  runSourceWatchPass,
  type SourceWatchState,
} from "../monitoring/plugin-source-watch.js";
import {
  getUserHooksFor,
  populateCacheAtBoot,
  resetPluginCacheForTests,
} from "../plugins/mtime-cache.js";
import {
  registerPlugin,
  resetPluginRegistryForTests,
} from "../plugins/registry.js";
import { getSourceVersionsPath } from "../plugins/source-versions.js";
import type { PluginCredentialKeyPattern } from "../plugins/types.js";
import { getPluginSecretPatterns } from "../security/plugin-secret-patterns.js";

// ─── Test fixtures ───────────────────────────────────────────────────────────

// realpath so the reconcile's symlink-resolving allowed-roots check matches
// on platforms where the tempdir is itself behind a symlink (macOS /var).
const ROOT = join(
  realpathSync(tmpdir()),
  `vellum-plugin-secret-pattern-contrib-test-${process.pid}-${Date.now()}`,
);

const PLUGINS_DIR = join(ROOT, "plugins");

const VIRLO_PATTERN: PluginCredentialKeyPattern = {
  label: "Virlo API Key",
  pattern: "virlo_tkn_[A-Za-z0-9_-]{20,}",
};

/** Fails the registry's literal-prefix rule (leading `.` is a wildcard). */
const INVALID_PATTERN: PluginCredentialKeyPattern = {
  label: "Broad Matcher",
  pattern: ".*secret",
};

function ensurePluginsDir(): void {
  rmSync(PLUGINS_DIR, { recursive: true, force: true });
  mkdirSync(PLUGINS_DIR, { recursive: true });
}

function writePluginDir(
  name: string,
  credentialKeyPatterns: PluginCredentialKeyPattern[],
): string {
  const dir = join(PLUGINS_DIR, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify(
      {
        name,
        version: "1.0.0",
        peerDependencies: { "@vellumai/plugin-api": "*" },
        credentialKeyPatterns,
      },
      null,
      2,
    ),
  );
  return dir;
}

function writeHook(dir: string, hookName: string, body: string): void {
  const hooksDir = join(dir, "hooks");
  mkdirSync(hooksDir, { recursive: true });
  writeFileSync(join(hooksDir, `${hookName}.ts`), body);
}

/** Registered-pattern labels are namespaced as `<label> (plugin:<name>)`. */
function findRegistered(label: string, pluginName: string) {
  return getPluginSecretPatterns().find(
    (p) => p.label === `${label} (plugin:${pluginName})`,
  );
}

/**
 * Watcher state shared by a test's publishes, reset per test so each test's
 * first publish takes a fresh baseline.
 */
let watchState: SourceWatchState | null = null;

/**
 * Publish pending source changes the way production does — one watcher pass —
 * then dispatch a hook read so the daemon-side sentinel gate applies the diff.
 */
async function publishAndDispatch(): Promise<void> {
  if (watchState === null) {
    watchState = createSourceWatchState();
  }
  runSourceWatchPass(watchState);
  await getUserHooksFor("user-prompt-submit");
}

// ─── Setup / teardown ────────────────────────────────────────────────────────

beforeAll(() => {
  process.env.VELLUM_WORKSPACE_DIR = ROOT;
});

beforeEach(() => {
  ensurePluginsDir();
  rmSync(getSourceVersionsPath(), { force: true });
  watchState = null;
  // Also clears the secret-pattern registry via resetPluginSecretPatternsForTests.
  resetPluginCacheForTests();
  resetPluginRegistryForTests();
});

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

// ─── User plugins (mtime-cache lifecycle) ────────────────────────────────────

describe("user plugin credential key pattern lifecycle", () => {
  test("activation at boot registers declared patterns with plugin-attributed labels", async () => {
    writePluginDir("virlo-plugin", [VIRLO_PATTERN]);

    await populateCacheAtBoot();

    const registered = findRegistered("Virlo API Key", "virlo-plugin");
    expect(registered).toBeDefined();
    expect(registered?.regex.source).toBe(VIRLO_PATTERN.pattern);
  });

  test("a runtime install makes patterns live without a restart", async () => {
    await populateCacheAtBoot();
    expect(getPluginSecretPatterns()).toHaveLength(0);

    writePluginDir("late-plugin", [VIRLO_PATTERN]);
    await publishAndDispatch();

    expect(findRegistered("Virlo API Key", "late-plugin")).toBeDefined();
  });

  test("uninstalling a plugin removes its patterns", async () => {
    const dir = writePluginDir("removable-plugin", [VIRLO_PATTERN]);
    await populateCacheAtBoot();
    expect(findRegistered("Virlo API Key", "removable-plugin")).toBeDefined();

    rmSync(dir, { recursive: true, force: true });
    await publishAndDispatch();

    expect(getPluginSecretPatterns()).toHaveLength(0);
  });

  test("disabling a plugin removes its patterns", async () => {
    const dir = writePluginDir("disableable-plugin", [VIRLO_PATTERN]);
    await populateCacheAtBoot();
    expect(findRegistered("Virlo API Key", "disableable-plugin")).toBeDefined();

    writeFileSync(join(dir, ".disabled"), "");
    await publishAndDispatch();

    expect(getPluginSecretPatterns()).toHaveLength(0);
  });

  test("an invalid declaration never blocks activation; the valid one still registers", async () => {
    const dir = writePluginDir("mixed-plugin", [
      VIRLO_PATTERN,
      INVALID_PATTERN,
    ]);
    writeHook(dir, "user-prompt-submit", `export default () => ({ ok: 1 });`);

    await populateCacheAtBoot();

    // Activation proceeded — the plugin's hook is live.
    expect(await getUserHooksFor("user-prompt-submit")).toHaveLength(1);
    // Only the valid pattern made it into the registry.
    expect(getPluginSecretPatterns()).toHaveLength(1);
    expect(findRegistered("Virlo API Key", "mixed-plugin")).toBeDefined();
    expect(findRegistered("Broad Matcher", "mixed-plugin")).toBeUndefined();
  });

  test("resetPluginCacheForTests clears the registry", async () => {
    writePluginDir("reset-plugin", [VIRLO_PATTERN]);
    await populateCacheAtBoot();
    expect(getPluginSecretPatterns()).toHaveLength(1);

    resetPluginCacheForTests();

    expect(getPluginSecretPatterns()).toHaveLength(0);
  });
});

// ─── Default/registered plugins (bootstrap lifecycle) ────────────────────────

describe("bootstrap credential key pattern lifecycle", () => {
  test("bootstrapPlugins registers a plugin's declared patterns", async () => {
    registerPlugin({
      manifest: {
        name: "fixture-secret-plugin",
        version: "0.0.1",
        credentialKeyPatterns: [VIRLO_PATTERN],
      },
      hooks: { init: async () => {} },
    });

    await bootstrapPlugins();

    expect(
      findRegistered("Virlo API Key", "fixture-secret-plugin"),
    ).toBeDefined();
  });

  test("a failed init rolls the plugin's patterns back", async () => {
    registerPlugin({
      manifest: {
        name: "failing-secret-plugin",
        version: "0.0.1",
        credentialKeyPatterns: [VIRLO_PATTERN],
      },
      hooks: {
        init: async () => {
          throw new Error("init boom");
        },
      },
    });

    await bootstrapPlugins();

    expect(
      findRegistered("Virlo API Key", "failing-secret-plugin"),
    ).toBeUndefined();
  });
});
