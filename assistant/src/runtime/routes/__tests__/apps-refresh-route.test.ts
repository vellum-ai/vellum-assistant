/**
 * Tests for POST apps/:id/refresh (apps_refresh) in the shared route table.
 *
 * `mock.module` is process-global in Bun. Stubs delegate to the real
 * implementations unless this file's tests are running.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

import type { CompileResult } from "../../../bundler/app-compiler.js";

let mockActive = false;
beforeAll(() => {
  mockActive = true;
});
afterAll(() => {
  mockActive = false;
});

const realCompiler = { ...(await import("../../../bundler/app-compiler.js")) };
const realNotify = {
  ...(await import("../../../daemon/app-change-notify.js")),
};

const compileApp = mock(
  async (
    _appDir: Parameters<typeof realCompiler.compileApp>[0],
  ): Promise<CompileResult> => ({
    ok: true,
    errors: [],
    warnings: [],
    durationMs: 11,
  }),
);
const notifyAppSurfacesChanged = mock(
  (..._args: Parameters<typeof realNotify.notifyAppSurfacesChanged>) => {},
);

mock.module("../../../bundler/app-compiler.js", () => ({
  ...realCompiler,
  compileApp: (...args: Parameters<typeof realCompiler.compileApp>) => {
    if (!mockActive) {
      return realCompiler.compileApp(...args);
    }
    return compileApp(...args);
  },
}));

mock.module("../../../daemon/app-change-notify.js", () => ({
  ...realNotify,
  notifyAppSurfacesChanged: (
    ...args: Parameters<typeof realNotify.notifyAppSurfacesChanged>
  ) => {
    if (!mockActive) {
      return realNotify.notifyAppSurfacesChanged(...args);
    }
    return notifyAppSurfacesChanged(...args);
  },
}));

const { createApp } = await import("../../../apps/app-store.js");
const { getWorkspacePluginsDir } = await import("../../../util/platform.js");
const { ROUTES } = await import("../app-management-routes.js");

function findHandler(operationId: string) {
  const route = ROUTES.find((r) => r.operationId === operationId);
  if (!route) {
    throw new Error(`Route ${operationId} not found`);
  }
  return route.handler;
}

const handleRefreshApp = findHandler("apps_refresh");

let workspaceDir: string;
let previousWorkspaceDir: string | undefined;

beforeEach(() => {
  previousWorkspaceDir = process.env.VELLUM_WORKSPACE_DIR;
  workspaceDir = join(
    tmpdir(),
    `vellum-apps-refresh-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  process.env.VELLUM_WORKSPACE_DIR = workspaceDir;
  compileApp.mockClear();
  notifyAppSurfacesChanged.mockClear();
  compileApp.mockResolvedValue({
    ok: true,
    errors: [],
    warnings: [],
    durationMs: 11,
  });
});

afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
  if (previousWorkspaceDir === undefined) {
    delete process.env.VELLUM_WORKSPACE_DIR;
  } else {
    process.env.VELLUM_WORKSPACE_DIR = previousWorkspaceDir;
  }
});

describe("apps_refresh route", () => {
  test("is registered on the shared app-management ROUTES table", () => {
    expect(typeof handleRefreshApp).toBe("function");
  });

  test("compiles a workspace app and notifies surfaces", async () => {
    const created = createApp({
      name: "Budget",
      schemaJson: "{}",
      htmlDefinition: "<h1>Budget</h1>",
    });

    const result = await handleRefreshApp({
      pathParams: { id: created.id },
    });

    expect(compileApp).toHaveBeenCalled();
    expect(notifyAppSurfacesChanged).toHaveBeenCalledWith(created.id, {
      fileChange: true,
    });
    expect(result).toEqual({
      ok: true,
      appId: created.id,
      name: "Budget",
      compiled: true,
      compile_duration_ms: 11,
    });
  });

  test("compiles a plugin app in place", async () => {
    const pluginName = `charts-${Math.random().toString(36).slice(2, 8)}`;
    const pluginDir = join(getWorkspacePluginsDir(), pluginName);
    mkdirSync(join(pluginDir, "apps", "viewer"), { recursive: true });
    writeFileSync(
      join(pluginDir, "package.json"),
      JSON.stringify({ name: pluginName, version: "1.0.0" }),
    );
    writeFileSync(join(pluginDir, "apps", "viewer", "index.html"), "<h1></h1>");
    const pluginAppId = `plugins~${pluginName}~viewer`;

    const result = await handleRefreshApp({
      pathParams: { id: pluginAppId },
    });

    expect(compileApp).toHaveBeenCalledWith(
      join(pluginDir, "apps", "viewer"),
    );
    expect(notifyAppSurfacesChanged).toHaveBeenCalledWith(pluginAppId, {
      fileChange: true,
    });
    expect(result).toMatchObject({
      ok: true,
      appId: pluginAppId,
      name: "viewer",
      compiled: true,
    });
  });

  test("returns compile errors without throwing", async () => {
    const created = createApp({
      name: "Budget",
      schemaJson: "{}",
      htmlDefinition: "<h1>Budget</h1>",
    });
    compileApp.mockImplementationOnce(async () => ({
      ok: false,
      errors: [{ text: "Could not resolve foo" }],
      warnings: [],
      durationMs: 4,
    }));

    const result = await handleRefreshApp({
      pathParams: { id: created.id },
    });

    expect(result).toMatchObject({
      compiled: false,
      compile_errors: [{ text: "Could not resolve foo" }],
    });
    expect(notifyAppSurfacesChanged).toHaveBeenCalled();
  });

  test("throws not found for an unknown app", async () => {
    await expect(
      handleRefreshApp({ pathParams: { id: "missing" } }),
    ).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});
