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

import { listAllPlugins, listInstalledPlugins } from "../list-installed-plugins.js";

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

describe("listAllPlugins", () => {
  test("includes default plugins with source=default", () => {
    const result = listAllPlugins({ workspacePluginsDir: pluginsDir });
    const defaults = result.filter((p) => p.source === "default");
    // All 15 default plugins should be present.
    expect(defaults.length).toBe(15);
    // Names should all start with "default-".
    expect(defaults.every((p) => p.name.startsWith("default-"))).toBe(true);
    // None should be disabled by default in a fresh temp dir.
    expect(defaults.every((p) => !p.disabled)).toBe(true);
  });

  test("includes user plugins with source=user", () => {
    mkdirSync(join(pluginsDir, "my-plugin"));
    writeFileSync(
      join(pluginsDir, "my-plugin", "package.json"),
      JSON.stringify({ name: "my-plugin", version: "1.0.0" }),
    );

    const result = listAllPlugins({ workspacePluginsDir: pluginsDir });
    const user = result.filter((p) => p.source === "user");
    expect(user).toHaveLength(1);
    expect(user[0]!.name).toBe("my-plugin");
    expect(user[0]!.disabled).toBe(false);
  });

  test("user plugins appear before default plugins", () => {
    mkdirSync(join(pluginsDir, "zzz-user"));
    writeFileSync(
      join(pluginsDir, "zzz-user", "package.json"),
      JSON.stringify({ name: "zzz-user", version: "1.0.0" }),
    );

    const result = listAllPlugins({ workspacePluginsDir: pluginsDir });
    const firstDefaultIdx = result.findIndex((p) => p.source === "default");
    const lastUserIdx = result
      .map((p, i) => (p.source === "user" ? i : -1))
      .filter((i) => i >= 0)
      .pop();

    expect(lastUserIdx).toBeDefined();
    expect(firstDefaultIdx).toBeGreaterThan(lastUserIdx!);
  });

  test("detects disabled state for user plugins", () => {
    mkdirSync(join(pluginsDir, "my-plugin"));
    writeFileSync(
      join(pluginsDir, "my-plugin", "package.json"),
      JSON.stringify({ name: "my-plugin", version: "1.0.0" }),
    );
    writeFileSync(join(pluginsDir, "my-plugin", ".disabled"), "");

    const result = listAllPlugins({ workspacePluginsDir: pluginsDir });
    const entry = result.find((p) => p.name === "my-plugin");
    expect(entry).toBeDefined();
    expect(entry!.disabled).toBe(true);
  });

  test("detects disabled state for default plugins via stub directory", () => {
    mkdirSync(join(pluginsDir, "default-advisor"), { recursive: true });
    writeFileSync(join(pluginsDir, "default-advisor", ".disabled"), "");

    const result = listAllPlugins({ workspacePluginsDir: pluginsDir });
    const advisor = result.find((p) => p.name === "default-advisor");
    expect(advisor).toBeDefined();
    expect(advisor!.disabled).toBe(true);
  });

  test("default plugins have version from their manifest", () => {
    const result = listAllPlugins({ workspacePluginsDir: pluginsDir });
    const advisor = result.find((p) => p.name === "default-advisor");
    expect(advisor).toBeDefined();
    expect(advisor!.packageJson?.version).toBeTruthy();
  });
});
