/**
 * Tests for the IPC-only `apps_refresh` method.
 *
 * `mock.module` is process-global in Bun. Stubs delegate to the real
 * implementations unless this file's tests are running, so a batched
 * `bun test` invocation cannot leak `/tmp/apps/budget` into inspect.
 */

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";

import type { CompileResult } from "../../../bundler/app-compiler.js";

let mockActive = false;
beforeAll(() => {
  mockActive = true;
});
afterAll(() => {
  mockActive = false;
});

const compileApp = mock(async (): Promise<CompileResult> => ({
  ok: true,
  errors: [],
  warnings: [],
  durationMs: 11,
}));
const notifyAppSurfacesChanged = mock(() => {});
const getApp = mock((id: string) =>
  id === "app-1" ? { id: "app-1", name: "Budget" } : null,
);
const getAppDirPath = mock(() => "/tmp/apps/budget");
const isPluginAppId = mock((id: string) => id.startsWith("plugins~"));

const realAppStore = { ...(await import("../../../apps/app-store.js")) };
const realCompiler = { ...(await import("../../../bundler/app-compiler.js")) };
const realNotify = {
  ...(await import("../../../daemon/app-change-notify.js")),
};

mock.module("../../../apps/app-store.js", () => ({
  ...realAppStore,
  getApp: (...args: Parameters<typeof realAppStore.getApp>) => {
    if (!mockActive) {
      return realAppStore.getApp(...args);
    }
    return getApp(...args);
  },
  getAppDirPath: (...args: Parameters<typeof realAppStore.getAppDirPath>) => {
    if (!mockActive) {
      return realAppStore.getAppDirPath(...args);
    }
    return getAppDirPath(...args);
  },
  isPluginAppId: (...args: Parameters<typeof realAppStore.isPluginAppId>) => {
    if (!mockActive) {
      return realAppStore.isPluginAppId(...args);
    }
    return isPluginAppId(...args);
  },
}));

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

const { handleAppsRefresh, APPS_IPC_METHODS } = await import(
  "../apps-ipc-routes.js"
);

describe("apps_refresh IPC", () => {
  test("is registered on the IPC-only map", () => {
    expect(typeof APPS_IPC_METHODS.apps_refresh).toBe("function");
  });

  test("compiles a workspace app and notifies surfaces", async () => {
    compileApp.mockClear();
    notifyAppSurfacesChanged.mockClear();
    compileApp.mockResolvedValue({
      ok: true,
      errors: [],
      warnings: [],
      durationMs: 11,
    } satisfies CompileResult);

    const result = await handleAppsRefresh({
      body: { appId: "app-1" },
    });

    expect(compileApp).toHaveBeenCalledWith("/tmp/apps/budget");
    expect(notifyAppSurfacesChanged).toHaveBeenCalledWith("app-1", {
      fileChange: true,
    });
    expect(result).toEqual({
      ok: true,
      appId: "app-1",
      name: "Budget",
      compiled: true,
      compile_duration_ms: 11,
    });
  });

  test("returns compile errors without throwing", async () => {
    compileApp.mockImplementationOnce(async () => ({
      ok: false,
      errors: [{ text: "Could not resolve foo" }],
      warnings: [],
      durationMs: 4,
    }));

    const result = await handleAppsRefresh({
      body: { appId: "app-1" },
    });

    expect(result).toMatchObject({
      compiled: false,
      compile_errors: [{ text: "Could not resolve foo" }],
    });
    expect(notifyAppSurfacesChanged).toHaveBeenCalled();
  });

  test("refuses plugin apps", async () => {
    compileApp.mockClear();
    await expect(
      handleAppsRefresh({ body: { appId: "plugins~charts~viewer" } }),
    ).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(compileApp).not.toHaveBeenCalled();
  });

  test("throws not found for an unknown workspace app", async () => {
    await expect(
      handleAppsRefresh({ body: { appId: "missing" } }),
    ).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});
