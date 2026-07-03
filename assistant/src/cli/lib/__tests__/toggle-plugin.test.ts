import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import {
  disablePlugin,
  enablePlugin,
  InvalidPluginNameError,
  PluginAlreadyInStateException,
  PluginDirectoryNotFoundError,
} from "../toggle-plugin.js";

// VELLUM_WORKSPACE_DIR is set to this; getWorkspacePluginsDir() returns
// <workspace>/plugins, so the actual plugins directory is TMP_WS_DIR/plugins.
const TMP_WS_DIR = join(import.meta.dir, "__tmp__toggle-plugin-test");
const TMP_PLUGINS_DIR = join(TMP_WS_DIR, "plugins");

beforeEach(() => {
  rmSync(TMP_WS_DIR, { recursive: true, force: true });
  mkdirSync(TMP_PLUGINS_DIR, { recursive: true });
  process.env.VELLUM_WORKSPACE_DIR = TMP_WS_DIR;
});

afterEach(() => {
  rmSync(TMP_WS_DIR, { recursive: true, force: true });
  delete process.env.VELLUM_WORKSPACE_DIR;
});

describe("disablePlugin", () => {
  it("creates .disabled sentinel for an existing user plugin directory", () => {
    const pluginDir = join(TMP_PLUGINS_DIR, "my-plugin");
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(join(pluginDir, "package.json"), "{}");

    const result = disablePlugin("my-plugin");

    expect(result.action).toBe("disable");
    expect(existsSync(join(pluginDir, ".disabled"))).toBe(true);
  });

  it("creates a stub directory for a default plugin that does not exist yet", () => {
    const pluginDir = join(TMP_PLUGINS_DIR, "default-advisor");

    const result = disablePlugin("default-advisor");

    expect(result.action).toBe("disable");
    expect(existsSync(pluginDir)).toBe(true);
    expect(existsSync(join(pluginDir, ".disabled"))).toBe(true);
  });

  it("throws PluginAlreadyInStateException if already disabled", () => {
    const pluginDir = join(TMP_PLUGINS_DIR, "my-plugin");
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(join(pluginDir, ".disabled"), "");

    expect(() => disablePlugin("my-plugin")).toThrow(
      PluginAlreadyInStateException,
    );
  });

  it("throws PluginDirectoryNotFoundError for non-default plugin with no directory", () => {
    expect(() => disablePlugin("nonexistent-plugin")).toThrow(
      PluginDirectoryNotFoundError,
    );
  });

  it("throws InvalidPluginNameError for path traversal attempts", () => {
    expect(() => disablePlugin("../state")).toThrow(InvalidPluginNameError);
    expect(() => disablePlugin("foo/bar")).toThrow(InvalidPluginNameError);
    expect(() => disablePlugin("..")).toThrow(InvalidPluginNameError);
  });

  it("throws InvalidPluginNameError for names with invalid characters", () => {
    expect(() => disablePlugin("My_Plugin!")).toThrow(InvalidPluginNameError);
    expect(() => disablePlugin("")).toThrow(InvalidPluginNameError);
    expect(() => disablePlugin(" ")).toThrow(InvalidPluginNameError);
  });
});

describe("enablePlugin", () => {
  it("removes .disabled sentinel from a user plugin directory", () => {
    const pluginDir = join(TMP_PLUGINS_DIR, "my-plugin");
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(join(pluginDir, "package.json"), "{}");
    writeFileSync(join(pluginDir, ".disabled"), "");

    const result = enablePlugin("my-plugin");

    expect(result.action).toBe("enable");
    expect(existsSync(join(pluginDir, ".disabled"))).toBe(false);
    // Plugin directory should still exist (it has package.json).
    expect(existsSync(pluginDir)).toBe(true);
  });

  it("removes stub directory for a default plugin when it becomes empty", () => {
    const pluginDir = join(TMP_PLUGINS_DIR, "default-advisor");
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(join(pluginDir, ".disabled"), "");

    enablePlugin("default-advisor");

    // Stub directory should be cleaned up since it only had the sentinel.
    expect(existsSync(pluginDir)).toBe(false);
  });

  it("keeps stub directory if it has other files besides .disabled", () => {
    const pluginDir = join(TMP_PLUGINS_DIR, "default-advisor");
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(join(pluginDir, ".disabled"), "");
    writeFileSync(join(pluginDir, "README.md"), "hello");

    enablePlugin("default-advisor");

    expect(existsSync(pluginDir)).toBe(true);
    expect(existsSync(join(pluginDir, ".disabled"))).toBe(false);
    expect(readdirSync(pluginDir)).toContain("README.md");
  });

  it("throws PluginAlreadyInStateException if not disabled", () => {
    const pluginDir = join(TMP_PLUGINS_DIR, "my-plugin");
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(join(pluginDir, "package.json"), "{}");

    expect(() => enablePlugin("my-plugin")).toThrow(
      PluginAlreadyInStateException,
    );
  });

  it("throws PluginDirectoryNotFoundError for non-default plugin with no directory", () => {
    // A missing user plugin must 404, not surface as an already-enabled no-op.
    expect(() => enablePlugin("nonexistent-plugin")).toThrow(
      PluginDirectoryNotFoundError,
    );
  });

  it("throws InvalidPluginNameError for path traversal attempts", () => {
    expect(() => enablePlugin("../state")).toThrow(InvalidPluginNameError);
    expect(() => enablePlugin("foo/bar")).toThrow(InvalidPluginNameError);
  });
});

describe("disable then enable round-trip", () => {
  it("default plugin: disable creates stub, enable removes it", () => {
    const pluginDir = join(TMP_PLUGINS_DIR, "default-memory");

    disablePlugin("default-memory");
    expect(existsSync(join(pluginDir, ".disabled"))).toBe(true);

    enablePlugin("default-memory");
    expect(existsSync(pluginDir)).toBe(false);
  });

  it("user plugin: disable then enable leaves directory intact", () => {
    const pluginDir = join(TMP_PLUGINS_DIR, "my-plugin");
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(join(pluginDir, "package.json"), '{"name":"my-plugin"}');

    disablePlugin("my-plugin");
    expect(existsSync(join(pluginDir, ".disabled"))).toBe(true);

    enablePlugin("my-plugin");
    expect(existsSync(join(pluginDir, ".disabled"))).toBe(false);
    expect(existsSync(join(pluginDir, "package.json"))).toBe(true);
  });
});
