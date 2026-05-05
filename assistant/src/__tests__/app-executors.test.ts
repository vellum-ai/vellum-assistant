import { describe, expect, mock, test } from "bun:test";

mock.module("../bundler/app-compiler.js", () => ({
  compileApp: async () => ({
    ok: true,
    errors: [],
    warnings: [],
    durationMs: 0,
  }),
}));

import type { AppDefinition } from "../memory/app-store.js";
import type { AppStore } from "../tools/apps/executors.js";
import {
  executeAppCreate,
  executeAppRefresh,
} from "../tools/apps/executors.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLegacyApp(overrides?: Partial<AppDefinition>): AppDefinition {
  return {
    id: "legacy-app",
    name: "Legacy App",
    schemaJson: "{}",
    htmlDefinition: "<html></html>",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

function makeMultifileApp(overrides?: Partial<AppDefinition>): AppDefinition {
  return {
    id: "multi-app",
    name: "Multifile App",
    schemaJson: "{}",
    htmlDefinition: "",
    formatVersion: 2,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

/**
 * Builds a minimal mock AppStore that tracks writes/edits/reads
 * against an in-memory file map.
 */
function mockStore(
  app: AppDefinition,
  files: Record<string, string> = {},
): AppStore {
  return {
    getApp: (id: string) => (id === app.id ? app : null),
    listApps: () => [app],
    appFileExists: (_appId: string, path: string) => path in files,
    createApp: () => app,
    updateApp: () => app,
    deleteApp: () => {},
    writeAppFile: (_appId: string, path: string, content: string) => {
      files[path] = content;
    },
  };
}

// ---------------------------------------------------------------------------
// executeAppCreate
// ---------------------------------------------------------------------------

describe("executeAppCreate", () => {
  test("creates multifile app with src/ scaffold", async () => {
    const files: Record<string, string> = {};
    let createdParams: Record<string, unknown> | undefined;
    const app = makeMultifileApp({ name: "New App" });
    const store: AppStore = {
      ...mockStore(app, files),
      createApp: (params) => {
        createdParams = params as unknown as Record<string, unknown>;
        return app;
      },
    };

    const result = await executeAppCreate(
      {
        name: "New App",
      },
      store,
    );

    expect(result.isError).toBe(false);
    // formatVersion 2 passed to createApp
    expect(createdParams?.formatVersion).toBe(2);
    // htmlDefinition should be empty for multifile apps
    expect(createdParams?.htmlDefinition).toBe("");
    // Scaffold files should be written
    expect(files["src/index.html"]).toBeDefined();
    expect(files["src/index.html"]).toContain("<title>New App</title>");
    expect(files["src/index.html"]).toContain('<div id="app"></div>');
    expect(files["src/main.tsx"]).toBeDefined();
    expect(files["src/main.tsx"]).toContain("import { render } from 'preact'");
    expect(files["src/main.tsx"]).toContain('{"Hello, New App!"}');
  });

  test("rejects retired html shortcut", async () => {
    const files: Record<string, string> = {};
    const app = makeMultifileApp({ name: "Custom App" });
    const store: AppStore = {
      ...mockStore(app, files),
      createApp: () => app,
    };

    const result = await executeAppCreate(
      {
        name: "Custom App",
        html: "<!DOCTYPE html><html><body></body></html>",
      },
      store,
    );

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content);
    expect(parsed.error).toContain("app_create no longer accepts html");
    expect(files["src/index.html"]).toBeUndefined();
    expect(files["src/main.tsx"]).toBeUndefined();
  });

  test("rejects retired pages shortcut", async () => {
    const files: Record<string, string> = {};
    const app = makeMultifileApp({ name: "Custom App" });
    const store = mockStore(app, files);

    const result = await executeAppCreate(
      {
        name: "Custom App",
        pages: {
          "settings.html": "<!DOCTYPE html><html><body></body></html>",
        },
      },
      store,
    );

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content);
    expect(parsed.error).toContain("app_create no longer accepts pages");
    expect(files["src/index.html"]).toBeUndefined();
    expect(files["src/main.tsx"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// executeAppRefresh
// ---------------------------------------------------------------------------

describe("executeAppRefresh", () => {
  test("legacy app: bumps updatedAt without compiling", async () => {
    const app = makeLegacyApp();
    const store = mockStore(app);
    const result = await executeAppRefresh({ app_id: app.id }, store);

    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.content);
    expect(parsed.refreshed).toBe(true);
    expect(parsed.appId).toBe(app.id);
    // Legacy apps should not have compile-related fields
    expect(parsed.compiled).toBeUndefined();
    expect(parsed.compile_errors).toBeUndefined();
  });

  test("multifile app: compiles src/ and returns result", async () => {
    const app = makeMultifileApp();
    const store = mockStore(app);
    const result = await executeAppRefresh({ app_id: app.id }, store);

    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.content);
    expect(parsed.refreshed).toBe(true);
    expect(parsed.appId).toBe(app.id);
    expect(parsed.compiled).toBe(true);
    expect(parsed.compile_duration_ms).toBeDefined();
  });

  test("returns error for unknown app", async () => {
    const app = makeLegacyApp();
    const store = mockStore(app);
    const result = await executeAppRefresh({ app_id: "nonexistent" }, store);

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content);
    expect(parsed.error).toContain("not found");
  });
});
