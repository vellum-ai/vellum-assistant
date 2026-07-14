import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  createApp,
  listAllApps,
  listPluginApps,
  resolveAppSource,
} from "../apps/app-store.js";
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
    expect(all[0].id).toBe(created.id);
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
    expect(plugin[0].id).toBe("plugins/acme/acme-dashboard");
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

describe("resolveAppSource", () => {
  test("resolves a workspace app by its UUID", () => {
    const created = createApp({
      name: "Budget",
      schemaJson: "{}",
      htmlDefinition: "<h1>Budget</h1>",
    });

    const source = resolveAppSource(created.id);
    expect(source).not.toBeNull();
    expect(source!.origin).toEqual({ kind: "workspace" });
    expect(source!.name).toBe("Budget");
    expect(source!.sourceDir).toContain(join("data", "apps"));
    // Single-file app (index.html at root).
    expect(source!.formatVersion).toBe(1);
  });

  test("resolves a plugin app by its plugins/<name>/<app> id", () => {
    const pluginDir = installPlugin("acme");
    bundleApp(pluginDir, "acme-dashboard");

    const source = resolveAppSource("plugins/acme/acme-dashboard");
    expect(source).not.toBeNull();
    expect(source!.origin).toEqual({ kind: "plugin", pluginName: "acme" });
    expect(source!.name).toBe("acme-dashboard");
    expect(source!.sourceDir).toBe(join(pluginDir, "apps", "acme-dashboard"));
    // bundleApp writes index.html at the root → single-file.
    expect(source!.formatVersion).toBe(1);
  });

  test("returns null for an unknown workspace id", () => {
    expect(resolveAppSource("11111111-1111-1111-1111-111111111111")).toBeNull();
  });

  test("returns null for a plugin app whose plugin is disabled", () => {
    const pluginDir = installPlugin("acme", { disabled: true });
    bundleApp(pluginDir, "acme-dashboard");

    expect(resolveAppSource("plugins/acme/acme-dashboard")).toBeNull();
  });

  test("returns null for a plugin dir without a package.json manifest", () => {
    // Stray directory shaped like a plugin app but not an installed plugin.
    const strayApp = join(
      getWorkspacePluginsDir(),
      "not-a-plugin",
      "apps",
      "x",
    );
    mkdirSync(strayApp, { recursive: true });

    expect(resolveAppSource("plugins/not-a-plugin/x")).toBeNull();
  });

  test("returns null for traversal and malformed plugin ids", () => {
    installPlugin("acme");
    expect(resolveAppSource("plugins/../secrets")).toBeNull();
    expect(resolveAppSource("plugins/acme/../..")).toBeNull();
    expect(resolveAppSource("plugins/acme")).toBeNull(); // missing app segment
    expect(resolveAppSource("plugins/acme/a/b")).toBeNull(); // too deep
  });
});
