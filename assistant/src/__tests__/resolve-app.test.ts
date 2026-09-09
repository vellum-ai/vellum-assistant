/**
 * Tests for resolving an app query by name, slug, or id.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createApp } from "../apps/app-store.js";
import { resolveAppQuery } from "../apps/resolve-app.js";
import { getWorkspacePluginsDir } from "../util/platform.js";

let workspaceDir: string;
let previousWorkspaceDir: string | undefined;

function freshWorkspace(): string {
  return join(
    tmpdir(),
    `vellum-resolve-app-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
}

function installPlugin(name: string): string {
  const pluginDir = join(getWorkspacePluginsDir(), name);
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(
    join(pluginDir, "package.json"),
    JSON.stringify({ name, version: "1.0.0" }),
  );
  return pluginDir;
}

function bundleApp(pluginDir: string, app: string): void {
  const appDir = join(pluginDir, "apps", app);
  mkdirSync(appDir, { recursive: true });
  writeFileSync(join(appDir, "index.html"), "<h1>Plugin app</h1>");
}

beforeEach(() => {
  previousWorkspaceDir = process.env.VELLUM_WORKSPACE_DIR;
  workspaceDir = freshWorkspace();
  process.env.VELLUM_WORKSPACE_DIR = workspaceDir;
});

afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
  if (previousWorkspaceDir === undefined) {
    delete process.env.VELLUM_WORKSPACE_DIR;
  } else {
    process.env.VELLUM_WORKSPACE_DIR = previousWorkspaceDir;
  }
});

describe("resolveAppQuery", () => {
  test("resolves a workspace app by display name, slug, and id", () => {
    const created = createApp({
      name: "Budget",
      schemaJson: "{}",
      htmlDefinition: "<h1>Budget</h1>",
    });

    const byName = resolveAppQuery("Budget");
    expect(byName.ok).toBe(true);
    if (byName.ok) {
      expect(byName.app.id).toBe(created.id);
    }

    const byNameCase = resolveAppQuery("budget");
    expect(byNameCase.ok).toBe(true);
    if (byNameCase.ok) {
      expect(byNameCase.app.id).toBe(created.id);
    }

    const slug = created.dirName ?? "";
    expect(slug.length).toBeGreaterThan(0);
    const bySlug = resolveAppQuery(slug);
    expect(bySlug.ok).toBe(true);
    if (bySlug.ok) {
      expect(bySlug.app.id).toBe(created.id);
    }

    const byId = resolveAppQuery(created.id);
    expect(byId.ok).toBe(true);
    if (byId.ok) {
      expect(byId.app.id).toBe(created.id);
    }
  });

  test("returns not_found for an unknown name", () => {
    const result = resolveAppQuery("missing");
    expect(result).toEqual({
      ok: false,
      reason: "not_found",
      query: "missing",
    });
  });

  test("returns ambiguous when two apps share a display name", () => {
    const first = createApp({
      name: "Notes",
      schemaJson: "{}",
      htmlDefinition: "<h1>One</h1>",
    });
    const second = createApp({
      name: "Notes",
      schemaJson: "{}",
      htmlDefinition: "<h1>Two</h1>",
    });

    const result = resolveAppQuery("Notes");
    expect(result.ok).toBe(false);
    if (!result.ok && result.reason === "ambiguous") {
      const ids = result.matches.map((m) => m.id).sort();
      expect(ids).toEqual([first.id, second.id].sort());
    } else {
      throw new Error("expected ambiguous resolution");
    }
  });

  test("resolves a plugin app by directory name", () => {
    const pluginDir = installPlugin("charts");
    bundleApp(pluginDir, "viewer");

    const result = resolveAppQuery("viewer");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.app.origin).toEqual({
        kind: "plugin",
        pluginName: "charts",
      });
      expect(result.app.id).toBe("plugins~charts~viewer");
    }
  });
});
