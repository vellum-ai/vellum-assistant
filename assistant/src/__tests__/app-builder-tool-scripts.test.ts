import { describe, expect, mock, test } from "bun:test";

import type { AppDefinition } from "../memory/app-store.js";
import type { AppStore } from "../tools/apps/executors.js";
import type { EditEngineResult } from "../tools/shared/filesystem/edit-engine.js";
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
    queryAppRecords: () => [],
    listAppFiles: () => ["index.html"],
    readAppFile: () => "<h1>Hi</h1>",
    createApp: (params) =>
      makeApp({ name: params.name, description: params.description }),
    updateApp: (id, updates) => makeApp({ id, ...updates }),
    deleteApp: () => {},
    writeAppFile: () => {},
    editAppFile: () =>
      ({
        ok: true,
        updatedContent: "new",
        matchCount: 1,
        matchMethod: "exact",
        similarity: 1,
        actualOld: "old",
        actualNew: "new",
      }) as EditEngineResult,
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
import * as appFileEditScript from "../config/bundled-skills/app-builder/tools/app-file-edit.js";
import * as appFileListScript from "../config/bundled-skills/app-builder/tools/app-file-list.js";
import * as appFileReadScript from "../config/bundled-skills/app-builder/tools/app-file-read.js";
import * as appFileWriteScript from "../config/bundled-skills/app-builder/tools/app-file-write.js";
import * as appListScript from "../config/bundled-skills/app-builder/tools/app-list.js";
import * as appQueryScript from "../config/bundled-skills/app-builder/tools/app-query.js";
import * as appUpdateScript from "../config/bundled-skills/app-builder/tools/app-update.js";

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
        { name: "My App", html: "<p>Hello</p>" },
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
        { name: "Auto App", html: "<div/>" },
        makeContext({ proxyToolResolver: proxy }),
      );
      expect(result.isError).toBe(false);
      const parsed = JSON.parse(result.content);
      expect(parsed.auto_opened).toBe(true);
      expect(parsed.open_result).toBe("opened");
    });

    test("handles missing proxyToolResolver gracefully", async () => {
      const result = await appCreateScript.run(
        { name: "No Proxy", html: "<p/>" },
        makeContext(),
      );
      expect(result.isError).toBe(false);
      const parsed = JSON.parse(result.content);
      // No auto-open fields when resolver is absent
      expect(parsed.auto_opened).toBeUndefined();
    });
  });

  // ---- app-list ----------------------------------------------------------

  describe("app-list", () => {
    test("exports a run function", () => {
      expect(typeof appListScript.run).toBe("function");
    });

    test("delegates to executeAppList and returns result", async () => {
      const result = await appListScript.run({}, makeContext());
      expect(result.isError).toBe(false);
      const parsed = JSON.parse(result.content);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.length).toBeGreaterThan(0);
      expect(parsed[0].id).toBe("app-1");
    });
  });

  // ---- app-query ---------------------------------------------------------

  describe("app-query", () => {
    test("exports a run function", () => {
      expect(typeof appQueryScript.run).toBe("function");
    });

    test("delegates to executeAppQuery and returns result", async () => {
      const result = await appQueryScript.run(
        { app_id: "app-1" },
        makeContext(),
      );
      expect(result.isError).toBe(false);
      expect(JSON.parse(result.content)).toEqual([]);
    });
  });

  // ---- app-update --------------------------------------------------------

  describe("app-update", () => {
    test("exports a run function", () => {
      expect(typeof appUpdateScript.run).toBe("function");
    });

    test("delegates to executeAppUpdate and returns result", async () => {
      const result = await appUpdateScript.run(
        { app_id: "app-1", name: "Updated" },
        makeContext(),
      );
      expect(result.isError).toBe(false);
      const parsed = JSON.parse(result.content);
      expect(parsed.name).toBe("Updated");
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

  // ---- app-file-list -----------------------------------------------------

  describe("app-file-list", () => {
    test("exports a run function", () => {
      expect(typeof appFileListScript.run).toBe("function");
    });

    test("delegates to executeAppFileList and returns result", async () => {
      const result = await appFileListScript.run(
        { app_id: "app-1" },
        makeContext(),
      );
      expect(result.isError).toBe(false);
      expect(JSON.parse(result.content)).toEqual(["index.html"]);
    });
  });

  // ---- app-file-read -----------------------------------------------------

  describe("app-file-read", () => {
    test("exports a run function", () => {
      expect(typeof appFileReadScript.run).toBe("function");
    });

    test("delegates to executeAppFileRead and returns formatted content", async () => {
      const result = await appFileReadScript.run(
        { app_id: "app-1", path: "index.html" },
        makeContext(),
      );
      expect(result.isError).toBe(false);
      // Content should include line numbers
      expect(result.content).toContain("1\t");
    });
  });

  // ---- app-file-edit -----------------------------------------------------

  describe("app-file-edit", () => {
    test("exports a run function", () => {
      expect(typeof appFileEditScript.run).toBe("function");
    });

    test("delegates to executeAppFileEdit and returns result", async () => {
      const result = await appFileEditScript.run(
        {
          app_id: "app-1",
          path: "index.html",
          old_string: "old",
          new_string: "new",
        },
        makeContext(),
      );
      expect(result.isError).toBe(false);
      const parsed = JSON.parse(result.content);
      expect(parsed.ok).toBe(true);
    });

    test("returns error when old_string is empty", async () => {
      const result = await appFileEditScript.run(
        {
          app_id: "app-1",
          path: "index.html",
          old_string: "",
          new_string: "new",
        },
        makeContext(),
      );
      expect(result.isError).toBe(true);
    });
  });

  // ---- app-file-write ----------------------------------------------------

  describe("app-file-write", () => {
    test("exports a run function", () => {
      expect(typeof appFileWriteScript.run).toBe("function");
    });

    test("delegates to executeAppFileWrite and returns result", async () => {
      const result = await appFileWriteScript.run(
        { app_id: "app-1", path: "new.html", content: "<div/>" },
        makeContext(),
      );
      expect(result.isError).toBe(false);
      const parsed = JSON.parse(result.content);
      expect(parsed.written).toBe(true);
      expect(parsed.path).toBe("new.html");
    });
  });
});
