/**
 * Tests for plugin config/data relocation into the plugin directory.
 *
 * Verifies that:
 * - `runInitHook` reads config from `<pluginDir>/config.json` (not global config)
 * - `runInitHook` points `pluginStorageDir` at `<pluginDir>/data/`
 * - Config migrates from the global `config.plugins.<name>` block on first init
 * - Data migrates from `<workspace>/plugins-data/<name>/` on first init
 * - PRESERVED_ENTRIES excludes config.json, data/, and .disabled from fingerprinting
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
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

import {
  computeFingerprint,
  PRESERVED_ENTRIES,
} from "../cli/lib/plugin-fingerprint.js";
import { resetHookCacheForTests } from "../hooks/hook-loader.js";
import {
  populateCacheAtBoot,
  resetPluginCacheForTests,
} from "../plugins/mtime-cache.js";

const ROOT = join(
  tmpdir(),
  `vellum-plugin-config-migration-${process.pid}-${Date.now()}`,
);

const PLUGINS_DIR = join(ROOT, "plugins");
const PLUGINS_DATA_DIR = join(ROOT, "plugins-data");

const SIMPLE_PKG = {
  version: "1.0.0",
  peerDependencies: { "@vellumai/plugin-api": "*" },
};

function freshPluginDir(name: string): string {
  const dir = join(PLUGINS_DIR, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writePackageJson(dir: string, pkg: Record<string, unknown>): void {
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkg, null, 2));
}

function writeInitHook(dir: string, body: string): void {
  const hooksDir = join(dir, "hooks");
  mkdirSync(hooksDir, { recursive: true });
  writeFileSync(join(hooksDir, "init.ts"), body);
}

beforeAll(() => {
  process.env.VELLUM_WORKSPACE_DIR = ROOT;
});

beforeEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(PLUGINS_DIR, { recursive: true });
  mkdirSync(PLUGINS_DATA_DIR, { recursive: true });
  resetHookCacheForTests();
  resetPluginCacheForTests();
});

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

describe("PRESERVED_ENTRIES", () => {
  test("includes install-meta.json, config.json, data, and .disabled", () => {
    expect(PRESERVED_ENTRIES).toContain("install-meta.json");
    expect(PRESERVED_ENTRIES).toContain("config.json");
    expect(PRESERVED_ENTRIES).toContain("data");
    expect(PRESERVED_ENTRIES).toContain(".disabled");
  });
});

describe("fingerprint exclusion of preserved entries", () => {
  test("config.json, data/, and .disabled are excluded from fingerprint", () => {
    const dir = join(PLUGINS_DIR, "fingerprint-test");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), '{"name":"fingerprint-test"}');
    writeFileSync(join(dir, "config.json"), '{"key":"value"}');
    writeFileSync(join(dir, ".disabled"), "");
    mkdirSync(join(dir, "data"), { recursive: true });
    writeFileSync(join(dir, "data", "state.json"), '{"count":1}');

    const fp = computeFingerprint(dir, PRESERVED_ENTRIES);

    // Source files are fingerprinted.
    expect(fp.files["package.json"]).toBeDefined();
    // Preserved entries are NOT fingerprinted.
    expect(fp.files["config.json"]).toBeUndefined();
    expect(fp.files["data"]).toBeUndefined();
    expect(fp.files["data/state.json"]).toBeUndefined();
    expect(fp.files[".disabled"]).toBeUndefined();
  });
});

describe("plugin config/data in plugin directory", () => {
  test("init hook receives config from <pluginDir>/config.json", async () => {
    const dir = freshPluginDir("cfg-plugin");
    writePackageJson(dir, { ...SIMPLE_PKG, name: "cfg-plugin" });
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({ apiKey: "secret123" }, null, 2),
    );

    // Write an init hook that writes the received config to a sentinel file
    // so we can inspect it after boot.
    const sentinel = join(ROOT, "cfg-sentinel.json");
    writeInitHook(
      dir,
      [
        'import { writeFileSync } from "node:fs";',
        'import type { InitContext } from "../../src/plugin-api/types.js";',
        "export default async (ctx: InitContext) => {",
        "  writeFileSync(" +
          JSON.stringify(sentinel) +
          ", JSON.stringify(ctx.config));",
        "};",
      ].join("\n"),
    );

    await populateCacheAtBoot();

    expect(existsSync(sentinel)).toBe(true);
    const received = JSON.parse(readFileSync(sentinel, "utf-8"));
    expect(received).toEqual({ apiKey: "secret123" });
  });

  test("init hook receives pluginStorageDir at <pluginDir>/data/", async () => {
    const dir = freshPluginDir("data-plugin");
    writePackageJson(dir, { ...SIMPLE_PKG, name: "data-plugin" });

    const sentinel = join(ROOT, "data-sentinel.txt");
    writeInitHook(
      dir,
      [
        'import { writeFileSync } from "node:fs";',
        'import type { InitContext } from "../../src/plugin-api/types.js";',
        "export default async (ctx: InitContext) => {",
        "  writeFileSync(" +
          JSON.stringify(sentinel) +
          ", ctx.pluginStorageDir);",
        "};",
      ].join("\n"),
    );

    await populateCacheAtBoot();

    expect(existsSync(sentinel)).toBe(true);
    const storageDir = readFileSync(sentinel, "utf-8");
    expect(storageDir).toBe(join(dir, "data"));
    expect(existsSync(storageDir)).toBe(true);
  });
});

describe("plugin host bundle on the mtime/hook-loader init path", () => {
  test("init hook receives a working ctx.host with every facet", async () => {
    const dir = freshPluginDir("host-plugin");
    writePackageJson(dir, { ...SIMPLE_PKG, name: "host-plugin" });

    // The init hook records the shape of `ctx.host` plus a few live probes
    // (config/logger/platform are safe to exercise without a DB or network) to
    // a sentinel so the test can assert the bundle was threaded through the
    // real `runInitHook` path — the same path installed user plugins take.
    const sentinel = join(ROOT, "host-sentinel.json");
    writeInitHook(
      dir,
      [
        'import { writeFileSync } from "node:fs";',
        'import type { InitContext } from "../../src/plugin-api/types.js";',
        "export default async (ctx: InitContext) => {",
        "  const host = ctx.host;",
        "  const out = {",
        "    present: host !== undefined,",
        "    facetKeys: host ? Object.keys(host).sort() : [],",
        "    workspaceDir: host?.platform.workspaceDir() ?? null,",
        "    loggerOk: typeof host?.logger.get('probe').info === 'function',",
        "    configGetSectionOk: typeof host?.config.getSection === 'function',",
        "    jobsOk: typeof host?.jobs.enqueue === 'function',",
        "    storeOk: typeof host?.store === 'object',",
        "  };",
        "  writeFileSync(" +
          JSON.stringify(sentinel) +
          ", JSON.stringify(out));",
        "};",
      ].join("\n"),
    );

    await populateCacheAtBoot();

    expect(existsSync(sentinel)).toBe(true);
    const received = JSON.parse(readFileSync(sentinel, "utf-8"));
    expect(received.present).toBe(true);
    // Every PluginHost facet must be present, scoped to this plugin.
    expect(received.facetKeys).toEqual([
      "config",
      "embeddings",
      "events",
      "history",
      "identity",
      "jobs",
      "logger",
      "memory",
      "platform",
      "providers",
      "registries",
      "store",
      "vectorStore",
    ]);
    // Live probes succeeded — the facets are wired, not just shaped.
    expect(received.workspaceDir).toBe(ROOT);
    expect(received.loggerOk).toBe(true);
    expect(received.configGetSectionOk).toBe(true);
    expect(received.jobsOk).toBe(true);
    expect(received.storeOk).toBe(true);
  });
});

describe("config migration from global config block", () => {
  test("migrates config from config.plugins.<name> to <pluginDir>/config.json", async () => {
    const dir = freshPluginDir("migrate-cfg");
    writePackageJson(dir, { ...SIMPLE_PKG, name: "migrate-cfg" });

    // Write the old config into the workspace config.json.
    const workspaceConfigPath = join(ROOT, "config.json");
    writeFileSync(
      workspaceConfigPath,
      JSON.stringify({
        plugins: {
          "migrate-cfg": { setting: "old-value", nested: { foo: 1 } },
        },
      }),
    );

    writeInitHook(
      dir,
      [
        'import { writeFileSync } from "node:fs";',
        'import type { InitContext } from "../../src/plugin-api/types.js";',
        "export default async (ctx: InitContext) => {",
        "  writeFileSync(" +
          JSON.stringify(join(ROOT, "migrate-cfg-sentinel.json")) +
          ", JSON.stringify(ctx.config));",
        "};",
      ].join("\n"),
    );

    await populateCacheAtBoot();

    // The config should have been migrated to the plugin directory.
    const configPath = join(dir, "config.json");
    expect(existsSync(configPath)).toBe(true);
    const migrated = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(migrated).toEqual({ setting: "old-value", nested: { foo: 1 } });

    // The init hook should have received the migrated config.
    const sentinel = join(ROOT, "migrate-cfg-sentinel.json");
    expect(existsSync(sentinel)).toBe(true);
    const received = JSON.parse(readFileSync(sentinel, "utf-8"));
    expect(received).toEqual({ setting: "old-value", nested: { foo: 1 } });
  });
});

describe("data migration from plugins-data/", () => {
  test("migrates data from <workspace>/plugins-data/<name>/ to <pluginDir>/data/", async () => {
    const dir = freshPluginDir("migrate-data");
    writePackageJson(dir, { ...SIMPLE_PKG, name: "migrate-data" });

    // Write old data to the legacy location.
    const oldDataDir = join(PLUGINS_DATA_DIR, "migrate-data");
    mkdirSync(oldDataDir, { recursive: true });
    writeFileSync(join(oldDataDir, "state.json"), '{"old":"data"}');
    writeFileSync(join(oldDataDir, "counter.txt"), "42");

    writeInitHook(
      dir,
      [
        'import { writeFileSync } from "node:fs";',
        'import type { InitContext } from "../../src/plugin-api/types.js";',
        "export default async (ctx: InitContext) => {",
        "  writeFileSync(" +
          JSON.stringify(join(ROOT, "migrate-data-sentinel.txt")) +
          ", ctx.pluginStorageDir);",
        "};",
      ].join("\n"),
    );

    await populateCacheAtBoot();

    // The data should have been migrated to the plugin directory.
    const newDataDir = join(dir, "data");
    expect(existsSync(newDataDir)).toBe(true);
    expect(existsSync(join(newDataDir, "state.json"))).toBe(true);
    expect(readFileSync(join(newDataDir, "state.json"), "utf-8")).toBe(
      '{"old":"data"}',
    );
    expect(readFileSync(join(newDataDir, "counter.txt"), "utf-8")).toBe("42");

    // The old directory should be removed.
    expect(existsSync(oldDataDir)).toBe(false);

    // The init hook should point at the new data directory.
    const sentinel = join(ROOT, "migrate-data-sentinel.txt");
    expect(existsSync(sentinel)).toBe(true);
    expect(readFileSync(sentinel, "utf-8")).toBe(newDataDir);
  });
});
