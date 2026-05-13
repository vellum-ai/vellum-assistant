/**
 * Tests for {@link listInstalledPlugins}.
 *
 * Each test materializes a temp workspace plugins directory and points
 * `listInstalledPlugins` at it via the `workspacePluginsDir` option — no
 * env mutation, no filesystem reach beyond `tmpdir()`.
 */

import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { listInstalledPlugins } from "../list-installed-plugins.js";

let pluginsDir: string;

beforeEach(() => {
  pluginsDir = mkdtempSync(join(tmpdir(), "plugins-list-"));
});

afterEach(() => {
  rmSync(pluginsDir, { recursive: true, force: true });
});

describe("listInstalledPlugins", () => {
  test("returns [] for a non-existent plugins directory", () => {
    const missing = join(pluginsDir, "does-not-exist");
    expect(listInstalledPlugins({ workspacePluginsDir: missing })).toEqual([]);
  });

  test("returns [] for an empty plugins directory", () => {
    expect(listInstalledPlugins({ workspacePluginsDir: pluginsDir })).toEqual(
      [],
    );
  });

  test("lists plugins alphabetically with parsed package.json metadata", () => {
    mkdirSync(join(pluginsDir, "zeta"));
    writeFileSync(
      join(pluginsDir, "zeta", "package.json"),
      JSON.stringify({
        name: "zeta",
        version: "1.2.3",
        description: "z plugin",
        peerDependencies: { "@vellumai/plugin-api": "0.8.0" },
      }),
    );
    mkdirSync(join(pluginsDir, "alpha"));
    writeFileSync(
      join(pluginsDir, "alpha", "package.json"),
      JSON.stringify({ name: "alpha", version: "0.1.0" }),
    );

    const result = listInstalledPlugins({ workspacePluginsDir: pluginsDir });
    expect(result.map((p) => p.name)).toEqual(["alpha", "zeta"]);
    expect(result[0]!.packageJson).toEqual({
      name: "alpha",
      version: "0.1.0",
      description: undefined,
      peerDependencies: undefined,
    });
    expect(result[1]!.packageJson).toEqual({
      name: "zeta",
      version: "1.2.3",
      description: "z plugin",
      peerDependencies: { "@vellumai/plugin-api": "0.8.0" },
    });
    expect(result.every((p) => p.issues.length === 0)).toBe(true);
  });

  test("reports missing package.json as an issue rather than failing", () => {
    mkdirSync(join(pluginsDir, "barebones"));

    const result = listInstalledPlugins({ workspacePluginsDir: pluginsDir });
    expect(result).toHaveLength(1);
    expect(result[0]!.packageJson).toBeNull();
    expect(result[0]!.issues).toEqual(["missing package.json"]);
  });

  test("reports malformed JSON as an issue rather than failing", () => {
    mkdirSync(join(pluginsDir, "broken"));
    writeFileSync(join(pluginsDir, "broken", "package.json"), "{not json");

    const result = listInstalledPlugins({ workspacePluginsDir: pluginsDir });
    expect(result).toHaveLength(1);
    expect(result[0]!.packageJson).toBeNull();
    expect(result[0]!.issues[0]).toMatch(/invalid JSON/);
  });

  test("reports non-object package.json as an issue", () => {
    mkdirSync(join(pluginsDir, "array-shaped"));
    writeFileSync(
      join(pluginsDir, "array-shaped", "package.json"),
      JSON.stringify([1, 2, 3]),
    );

    const result = listInstalledPlugins({ workspacePluginsDir: pluginsDir });
    expect(result).toHaveLength(1);
    expect(result[0]!.packageJson).toBeNull();
    expect(result[0]!.issues).toContain("package.json is not an object");
  });

  test("skips hidden entries and non-directories", () => {
    mkdirSync(join(pluginsDir, ".hidden-dir"));
    writeFileSync(join(pluginsDir, "stray-file.txt"), "noise");
    mkdirSync(join(pluginsDir, "visible"));
    writeFileSync(
      join(pluginsDir, "visible", "package.json"),
      JSON.stringify({ name: "visible", version: "0.0.1" }),
    );

    const result = listInstalledPlugins({ workspacePluginsDir: pluginsDir });
    expect(result.map((p) => p.name)).toEqual(["visible"]);
  });

  test("follows symlinks that resolve to directories", () => {
    const real = mkdtempSync(join(tmpdir(), "real-plugin-"));
    try {
      writeFileSync(
        join(real, "package.json"),
        JSON.stringify({ name: "linked", version: "0.0.1" }),
      );
      symlinkSync(real, join(pluginsDir, "linked"));

      const result = listInstalledPlugins({ workspacePluginsDir: pluginsDir });
      expect(result.map((p) => p.name)).toEqual(["linked"]);
      expect(result[0]!.packageJson?.name).toBe("linked");
    } finally {
      rmSync(real, { recursive: true, force: true });
    }
  });

  test("ignores broken symlinks rather than throwing", () => {
    symlinkSync(
      join(pluginsDir, "does-not-exist"),
      join(pluginsDir, "dangling"),
    );
    mkdirSync(join(pluginsDir, "valid"));
    writeFileSync(
      join(pluginsDir, "valid", "package.json"),
      JSON.stringify({ name: "valid", version: "0.0.1" }),
    );

    const result = listInstalledPlugins({ workspacePluginsDir: pluginsDir });
    expect(result.map((p) => p.name)).toEqual(["valid"]);
  });
});
