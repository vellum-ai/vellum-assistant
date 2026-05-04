import { describe, expect, mock, test } from "bun:test";

import type { AppDefinition } from "../memory/app-store.js";
import type { AppStore } from "../tools/apps/executors.js";
import type { ToolContext } from "../tools/types.js";

// ---------------------------------------------------------------------------
// Mock factory helpers
// ---------------------------------------------------------------------------

function makeApp(overrides: Partial<AppDefinition> = {}): AppDefinition {
  return {
    id: "app-1",
    name: "Test App",
    description: "A test app",
    schemaJson: "{}",
    htmlDefinition: "<h1>Hi</h1>",
    createdAt: 1000,
    updatedAt: 2000,
    ...overrides,
  };
}

function makeMockStore(overrides: Partial<AppStore> = {}): AppStore {
  return {
    getApp: () => makeApp(),
    listApps: () => [makeApp()],
    appFileExists: () => false,
    createApp: (params) =>
      makeApp({ name: params.name, description: params.description }),
    updateApp: (id, updates) => makeApp({ id, ...updates }),
    deleteApp: () => {},
    writeAppFile: () => {},
    ...overrides,
  };
}

function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workingDir: "/tmp",
    conversationId: "conv-1",
    trustClass: "guardian",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Mock the app-store module so that skill scripts import our controllable store
// ---------------------------------------------------------------------------

const mockStore = makeMockStore();

mock.module("../memory/app-store.js", () => ({
  ...mockStore,
  getAppsDir: () => "/tmp/test-apps",
  getAppDirPath: (appId: string) => `/tmp/test-apps/${appId}`,
  resolveAppDir: (id: string) => ({
    dirName: id,
    appDir: `/tmp/test-apps/${id}`,
  }),
  isMultifileApp: (app: AppDefinition) => app.formatVersion === 2,
}));

// Mock compileApp for multifile scaffold path
mock.module("../bundler/app-compiler.js", () => ({
  compileApp: async () => ({
    ok: true,
    errors: [],
    warnings: [],
    durationMs: 0,
  }),
}));

// ---------------------------------------------------------------------------
// Import skill scripts (after mocking)
// ---------------------------------------------------------------------------

import * as appCreateScript from "../config/bundled-skills/app-builder/tools/app-create.js";
import * as appDeleteScript from "../config/bundled-skills/app-builder/tools/app-delete.js";
import * as appRefreshScript from "../config/bundled-skills/app-builder/tools/app-refresh.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("app-builder skill tool scripts", () => {
  // ---- app-create --------------------------------------------------------

  describe("app-create", () => {
    test("exports a run function", () => {
      expect(typeof appCreateScript.run).toBe("function");
    });

    test("delegates to executeAppCreate and returns result", async () => {
      const result = await appCreateScript.run(
        { name: "My App" },
        makeContext(),
      );
      expect(result.isError).toBe(false);
      const parsed = JSON.parse(result.content);
      expect(parsed.name).toBe("My App");
    });

    test("passes proxyToolResolver from context for auto-open", async () => {
      const proxy: ToolContext["proxyToolResolver"] = async () => ({
        content: "opened",
        isError: false,
      });
      const result = await appCreateScript.run(
        { name: "Auto App" },
        makeContext({ proxyToolResolver: proxy }),
      );
      expect(result.isError).toBe(false);
      const parsed = JSON.parse(result.content);
      expect(parsed.auto_opened).toBe(true);
      expect(parsed.open_result).toBe("opened");
    });

    test("handles missing proxyToolResolver gracefully", async () => {
      const result = await appCreateScript.run(
        { name: "No Proxy" },
        makeContext(),
      );
      expect(result.isError).toBe(false);
      const parsed = JSON.parse(result.content);
      // No auto-open fields when resolver is absent
      expect(parsed.auto_opened).toBeUndefined();
    });
  });

  // ---- app-delete --------------------------------------------------------

  describe("app-delete", () => {
    test("exports a run function", () => {
      expect(typeof appDeleteScript.run).toBe("function");
    });

    test("delegates to executeAppDelete and returns result", async () => {
      const result = await appDeleteScript.run(
        { app_id: "app-1" },
        makeContext(),
      );
      expect(result.isError).toBe(false);
      const parsed = JSON.parse(result.content);
      expect(parsed.deleted).toBe(true);
      expect(parsed.appId).toBe("app-1");
    });
  });

  // ---- app-refresh -------------------------------------------------------

  describe("app-refresh", () => {
    test("exports a run function", () => {
      expect(typeof appRefreshScript.run).toBe("function");
    });

    test("delegates to executeAppRefresh and returns result", async () => {
      const result = await appRefreshScript.run(
        { app_id: "app-1" },
        makeContext(),
      );
      expect(result.isError).toBe(false);
      const parsed = JSON.parse(result.content);
      expect(parsed.refreshed).toBe(true);
      expect(parsed.appId).toBe("app-1");
    });
  });
});
