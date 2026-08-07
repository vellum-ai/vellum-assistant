/**
 * Enumeration of installed plugin directories, including the realpath
 * containment boundary that keeps a symlinked root pointing outside the
 * plugins directory out of the list.
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
import { afterAll, beforeEach, describe, expect, test } from "bun:test";

import { getWorkspacePluginsDir } from "../../util/platform.js";
import { listInstalledPluginDirs } from "../installed-plugin-dirs.js";

const pluginsDir = getWorkspacePluginsDir();
const outsideRoot = mkdtempSync(join(tmpdir(), "installed-plugin-dirs-"));

afterAll(() => {
  rmSync(outsideRoot, { recursive: true, force: true });
  rmSync(pluginsDir, { recursive: true, force: true });
});

/** A directory carrying the `package.json` that marks it as an install. */
function makePluginDir(parent: string, name: string): string {
  const dir = join(parent, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name, version: "1.0.0" }),
  );
  return dir;
}

beforeEach(() => {
  rmSync(pluginsDir, { recursive: true, force: true });
  mkdirSync(pluginsDir, { recursive: true });
});

describe("listInstalledPluginDirs", () => {
  test("lists real plugin directories and skips dot entries", () => {
    makePluginDir(pluginsDir, "alpha");
    makePluginDir(pluginsDir, ".hidden");
    mkdirSync(join(pluginsDir, "no-manifest"), { recursive: true });

    expect(listInstalledPluginDirs().map((p) => p.name)).toEqual(["alpha"]);
  });

  test("skips a symlinked plugin root that points outside the plugins dir", () => {
    const escapee = makePluginDir(outsideRoot, "escapee");
    symlinkSync(escapee, join(pluginsDir, "escapee"));
    makePluginDir(pluginsDir, "contained");

    // The plugin loader refuses to import from a root that resolves outside
    // the plugins directory, so enumeration must not report it as installed:
    // a caller acting on this list would arm and run code the loader would
    // never activate.
    expect(listInstalledPluginDirs().map((p) => p.name)).toEqual(["contained"]);
  });

  test("skips a symlink that aliases the plugins directory itself", () => {
    symlinkSync(pluginsDir, join(pluginsDir, "self"));

    expect(listInstalledPluginDirs()).toEqual([]);
  });

  test("keeps a symlinked plugin root that stays inside the plugins dir", () => {
    const real = makePluginDir(pluginsDir, "real");
    symlinkSync(real, join(pluginsDir, "alias"));

    expect(
      listInstalledPluginDirs()
        .map((p) => p.name)
        .sort(),
    ).toEqual(["alias", "real"]);
  });
});
