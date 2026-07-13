import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createApp, listAllApps, listPluginApps } from "../apps/app-store.js";
import { getWorkspacePluginsDir } from "../util/platform.js";

let workspaceDir: string;

function freshWorkspace(): string {
  return join(
    tmpdir(),
    `vellum-list-all-apps-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
}

/**
 * Materialize an installed plugin under `<workspace>/plugins/<name>/` with a
 * package.json manifest. Returns the plugin directory path.
 */
function installPlugin(
  name: string,
  opts: { disabled?: boolean } = {},
): string {
  const pluginDir = join(getWorkspacePluginsDir(), name);
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(
    join(pluginDir, "package.json"),
    JSON.stringify({ name, version: "1.0.0" }),
  );
  if (opts.disabled) {
    writeFileSync(join(pluginDir, ".disabled"), "");
  }
  return pluginDir;
}

/**
 * Bundle an app inside a plugin as a directory under `<pluginDir>/apps/<app>/`.
 */
function bundleApp(pluginDir: string, app: string): void {
  const appDir = join(pluginDir, "apps", app);
  mkdirSync(appDir, { recursive: true });
  writeFileSync(join(appDir, "index.html"), "<h1>Plugin app</h1>");
}

beforeEach(() => {
  workspaceDir = freshWorkspace();
  process.env.VELLUM_WORKSPACE_DIR = workspaceDir;
});

afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
});

describe("listAllApps", () => {
  test("returns nothing when no apps exist", () => {
    expect(listAllApps()).toEqual([]);
    expect(listPluginApps()).toEqual([]);
  });

  test("tags workspace apps with the workspace origin", () => {
    const created = createApp({
      name: "Budget",
      schemaJson: "{}",
      htmlDefinition: "<h1>Budget</h1>",
    });

    const all = listAllApps();
    expect(all).toHaveLength(1);
    expect(all[0].origin).toEqual({ kind: "workspace" });
    expect(all[0].name).toBe("Budget");
    // Workspace source resolves through the dirName-based resolver.
    expect(all[0].sourcePath).toContain(join("data", "apps"));
    expect(all[0].sourcePath).toContain(created.dirName ?? created.id);
  });

  test("discovers plugin apps by directory, tagged plugin:<name>", () => {
    createApp({
      name: "Budget",
      schemaJson: "{}",
      htmlDefinition: "<h1>Budget</h1>",
    });
    const pluginDir = installPlugin("acme");
    bundleApp(pluginDir, "acme-dashboard");

    const plugin = listPluginApps();
    expect(plugin).toHaveLength(1);
    expect(plugin[0].origin).toEqual({ kind: "plugin", pluginName: "acme" });
    expect(plugin[0].name).toBe("acme-dashboard");
    expect(plugin[0].sourcePath).toBe(
      join(pluginDir, "apps", "acme-dashboard"),
    );

    // Workspace apps come first, then plugin apps.
    const all = listAllApps();
    expect(all.map((a) => a.origin.kind)).toEqual(["workspace", "plugin"]);
  });

  test("ignores directories under plugins/ without a package.json manifest", () => {
    // A stray directory that is not an installed plugin, even with an apps/ dir.
    const strayDir = join(getWorkspacePluginsDir(), "not-a-plugin");
    mkdirSync(join(strayDir, "apps", "ghost"), { recursive: true });

    expect(listPluginApps()).toEqual([]);
  });

  test("includes apps from a symlinked plugin directory", () => {
    // Real plugin lives outside plugins/; plugins/<name> is a symlink to it.
    const realPluginDir = join(workspaceDir, "external-acme");
    mkdirSync(realPluginDir, { recursive: true });
    writeFileSync(
      join(realPluginDir, "package.json"),
      JSON.stringify({ name: "acme", version: "1.0.0" }),
    );
    bundleApp(realPluginDir, "acme-dashboard");

    mkdirSync(getWorkspacePluginsDir(), { recursive: true });
    symlinkSync(realPluginDir, join(getWorkspacePluginsDir(), "acme"));

    const plugin = listPluginApps();
    expect(plugin).toHaveLength(1);
    expect(plugin[0].name).toBe("acme-dashboard");
    expect(plugin[0].origin).toEqual({ kind: "plugin", pluginName: "acme" });
  });

  test("excludes apps from disabled plugins", () => {
    const pluginDir = installPlugin("acme", { disabled: true });
    bundleApp(pluginDir, "acme-dashboard");

    expect(listPluginApps()).toEqual([]);
    expect(listAllApps()).toEqual([]);
  });
});
