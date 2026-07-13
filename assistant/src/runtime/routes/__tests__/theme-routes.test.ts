import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { WorkspaceThemeReadResult } from "../../../theme/workspace-theme.js";
import { ROUTES } from "../theme-routes.js";

function getThemeHandler() {
  const route = ROUTES.find((r) => r.operationId === "workspace_theme_get");
  if (!route) {
    throw new Error("workspace_theme_get route not registered");
  }
  expect(route.endpoint).toBe("workspace/theme");
  expect(route.method).toBe("GET");
  return route.handler as () => WorkspaceThemeReadResult;
}

describe("GET /workspace/theme", () => {
  let workspaceDir: string;
  let prevWorkspaceDir: string | undefined;

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), "theme-route-test-"));
    prevWorkspaceDir = process.env.VELLUM_WORKSPACE_DIR;
    process.env.VELLUM_WORKSPACE_DIR = workspaceDir;
  });

  afterEach(() => {
    if (prevWorkspaceDir === undefined) {
      delete process.env.VELLUM_WORKSPACE_DIR;
    } else {
      process.env.VELLUM_WORKSPACE_DIR = prevWorkspaceDir;
    }
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  test("returns source none when no theme file exists", () => {
    const result = getThemeHandler()();
    expect(result).toEqual({ theme: null, source: "none", issues: [] });
  });

  test("returns the validated theme when the file is valid", () => {
    mkdirSync(join(workspaceDir, "ui"), { recursive: true });
    writeFileSync(
      join(workspaceDir, "ui", "theme.json"),
      JSON.stringify({ version: 1, base: "velvet" }),
    );
    const result = getThemeHandler()();
    expect(result.source).toBe("workspace");
    expect(result.theme).toEqual({ version: 1, base: "velvet" });
    expect(result.issues).toEqual([]);
  });

  test("returns null theme plus issues when the file is rejected", () => {
    mkdirSync(join(workspaceDir, "ui"), { recursive: true });
    writeFileSync(
      join(workspaceDir, "ui", "theme.json"),
      JSON.stringify({ version: 1, tokens: { accent: "not-a-color" } }),
    );
    const result = getThemeHandler()();
    expect(result.source).toBe("invalid");
    expect(result.theme).toBeNull();
    expect(result.issues.length).toBeGreaterThan(0);
  });
});
