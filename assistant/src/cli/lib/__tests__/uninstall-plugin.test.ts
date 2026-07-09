/**
 * Tests for {@link uninstallPlugin}.
 *
 * The `shutdown` hook is resolved from `<workspace>/plugins/<name>/hooks` (the
 * installer-enforced layout), so tests materialize plugins under the real
 * workspace plugins directory — the test-preload temp workspace — rather than a
 * divergent temp dir. `workspacePluginsDir` is passed as the same directory so
 * the rm target and the hook-resolution path stay in agreement, matching
 * production (where the override is omitted and both fall back to it).
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { resetHookCacheForTests } from "../../../hooks/hook-loader.js";
import { getWorkspacePluginsDir } from "../../../util/platform.js";
import { InvalidPluginNameError } from "../install-from-github.js";
import {
  PluginNotInstalledError,
  uninstallPlugin,
} from "../uninstall-plugin.js";

let pluginsDir: string;

beforeEach(() => {
  pluginsDir = getWorkspacePluginsDir();
  rmSync(pluginsDir, { recursive: true, force: true });
  mkdirSync(pluginsDir, { recursive: true });
  resetHookCacheForTests();
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
  test("removes the install target recursively", async () => {
    const target = writePlugin("simple-memory");
    expect(existsSync(target)).toBe(true);

    const result = await uninstallPlugin({
      name: "simple-memory",
      workspacePluginsDir: pluginsDir,
    });

    expect(result).toEqual({ name: "simple-memory", target });
    expect(existsSync(target)).toBe(false);
    expect(readdirSync(pluginsDir)).toEqual([]);
  });

  test("runs the plugin's shutdown hook from disk before removing it", async () => {
    const target = writePlugin("with-shutdown");
    // Marker lives in the plugins dir (not the target), so it survives the rm
    // and proves the shutdown hook ran during the uninstall.
    const marker = join(pluginsDir, "shutdown-ran.txt");
    writeFileSync(
      join(target, "hooks", "shutdown.ts"),
      `import { writeFileSync } from "node:fs";\n` +
        `export default (ctx: { reason: string }) => {\n` +
        `  writeFileSync(${JSON.stringify(marker)}, ctx.reason);\n` +
        `};\n`,
    );

    await uninstallPlugin({
      name: "with-shutdown",
      workspacePluginsDir: pluginsDir,
    });

    expect(existsSync(target)).toBe(false);
    expect(existsSync(marker)).toBe(true);
    expect(readFileSync(marker, "utf8")).toBe("uninstall");
  });

  test("throws PluginNotInstalledError when no directory exists", async () => {
    await expect(
      uninstallPlugin({
        name: "ghost",
        workspacePluginsDir: pluginsDir,
      }),
    ).rejects.toThrow(PluginNotInstalledError);
  });

  test("throws PluginNotInstalledError when the target is a regular file", async () => {
    writeFileSync(join(pluginsDir, "trap"), "not a plugin");

    await expect(
      uninstallPlugin({
        name: "trap",
        workspacePluginsDir: pluginsDir,
      }),
    ).rejects.toThrow(PluginNotInstalledError);
  });

  test("removes a symlinked plugin without touching the link target", async () => {
    const real = mkdtempSync(join(tmpdir(), "real-plugin-"));
    try {
      writeFileSync(
        join(real, "package.json"),
        JSON.stringify({ name: "linked", version: "0.0.1" }),
      );
      symlinkSync(real, join(pluginsDir, "linked"));

      await uninstallPlugin({
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

  test("does not run shutdown for a disabled plugin", async () => {
    const target = writePlugin("disabled-plugin");
    // Add a shutdown hook that would write a marker if executed.
    const marker = join(pluginsDir, "shutdown-ran.txt");
    writeFileSync(
      join(target, "hooks", "shutdown.ts"),
      `import { writeFileSync } from "node:fs";\n` +
        `export default (ctx: { reason: string }) => {\n` +
        `  writeFileSync(${JSON.stringify(marker)}, ctx.reason);\n` +
        `};\n`,
    );
    // Disable the plugin via the .disabled sentinel.
    writeFileSync(join(target, ".disabled"), "");

    await uninstallPlugin({
      name: "disabled-plugin",
      workspacePluginsDir: pluginsDir,
    });

    expect(existsSync(target)).toBe(false);
    // The shutdown hook must NOT have run — a disabled plugin's code
    // should never execute, including during uninstall.
    expect(existsSync(marker)).toBe(false);
  });

  test.each([
    ["../escape"],
    ["/abs/path"],
    [".hidden"],
    ["Name-WithCaps"],
    ["space name"],
    [""],
  ])(
    "rejects invalid plugin name %p before touching the filesystem",
    async (bad) => {
      // Salt the plugins dir with siblings to prove we don't blow them away.
      writePlugin("real-plugin");
      await expect(
        uninstallPlugin({ name: bad, workspacePluginsDir: pluginsDir }),
      ).rejects.toThrow(InvalidPluginNameError);
      expect(existsSync(join(pluginsDir, "real-plugin"))).toBe(true);
    },
  );
});
