/**
 * Tests for {@link uninstallPlugin}.
 *
 * Each test materializes a temp workspace plugins directory and points
 * `uninstallPlugin` at it via the `workspacePluginsDir` option.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { InvalidPluginNameError } from "../install-from-github.js";
import {
  PluginNotInstalledError,
  uninstallPlugin,
} from "../uninstall-plugin.js";

let pluginsDir: string;

beforeEach(() => {
  pluginsDir = mkdtempSync(join(tmpdir(), "plugins-uninstall-"));
});

afterEach(() => {
  rmSync(pluginsDir, { recursive: true, force: true });
});

function writePlugin(name: string): string {
  const target = join(pluginsDir, name);
  mkdirSync(join(target, "hooks"), { recursive: true });
  writeFileSync(
    join(target, "package.json"),
    JSON.stringify({ name, version: "0.0.1" }),
  );
  writeFileSync(
    join(target, "hooks", "init.ts"),
    "export async function init() {}\n",
  );
  return target;
}

describe("uninstallPlugin", () => {
  test("removes the install target recursively", () => {
    const target = writePlugin("simple-memory");
    expect(existsSync(target)).toBe(true);

    const result = uninstallPlugin({
      name: "simple-memory",
      workspacePluginsDir: pluginsDir,
    });

    expect(result).toEqual({ name: "simple-memory", target });
    expect(existsSync(target)).toBe(false);
    expect(readdirSync(pluginsDir)).toEqual([]);
  });

  test("throws PluginNotInstalledError when no directory exists", () => {
    expect(() =>
      uninstallPlugin({
        name: "ghost",
        workspacePluginsDir: pluginsDir,
      }),
    ).toThrow(PluginNotInstalledError);
  });

  test("throws PluginNotInstalledError when the target is a regular file", () => {
    writeFileSync(join(pluginsDir, "trap"), "not a plugin");

    expect(() =>
      uninstallPlugin({
        name: "trap",
        workspacePluginsDir: pluginsDir,
      }),
    ).toThrow(PluginNotInstalledError);
  });

  test("removes a symlinked plugin without touching the link target", () => {
    const real = mkdtempSync(join(tmpdir(), "real-plugin-"));
    try {
      writeFileSync(
        join(real, "package.json"),
        JSON.stringify({ name: "linked", version: "0.0.1" }),
      );
      symlinkSync(real, join(pluginsDir, "linked"));

      uninstallPlugin({
        name: "linked",
        workspacePluginsDir: pluginsDir,
      });

      expect(existsSync(join(pluginsDir, "linked"))).toBe(false);
      // Real directory and its files remain — rm only removed the symlink.
      expect(existsSync(real)).toBe(true);
      expect(existsSync(join(real, "package.json"))).toBe(true);
    } finally {
      rmSync(real, { recursive: true, force: true });
    }
  });

  test.each([
    ["../escape"],
    ["/abs/path"],
    [".hidden"],
    ["Name-WithCaps"],
    ["space name"],
    [""],
  ])("rejects invalid plugin name %p before touching the filesystem", (bad) => {
    // Salt the plugins dir with siblings to prove we don't blow them away.
    writePlugin("real-plugin");
    expect(() =>
      uninstallPlugin({ name: bad, workspacePluginsDir: pluginsDir }),
    ).toThrow(InvalidPluginNameError);
    expect(existsSync(join(pluginsDir, "real-plugin"))).toBe(true);
  });
});
