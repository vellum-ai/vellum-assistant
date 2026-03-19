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
import { executeAppCreate } from "../tools/apps/executors.js";

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
    queryAppRecords: () => [],
    listAppFiles: () => Object.keys(files).sort(),
    readAppFile: (_appId: string, path: string) => {
      if (!(path in files)) throw new Error(`File not found: ${path}`);
      return files[path];
    },
    createApp: () => app,
    updateApp: () => app,
    deleteApp: () => {},
    writeAppFile: (_appId: string, path: string, content: string) => {
      files[path] = content;
    },
    editAppFile: (
      _appId: string,
      path: string,
      oldStr: string,
      newStr: string,
      _replaceAll?: boolean,
    ) => {
      if (!(path in files)) throw new Error(`File not found: ${path}`);
      const content = files[path];
      if (!content.includes(oldStr)) {
        return { ok: false as const, reason: "not_found" as const };
      }
      const updated = content.replace(oldStr, newStr);
      files[path] = updated;
      return {
        ok: true as const,
        updatedContent: updated,
        matchCount: 1,
        matchMethod: "exact" as const,
        similarity: 1,
        actualOld: oldStr,
        actualNew: newStr,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// executeAppCreate
// ---------------------------------------------------------------------------

describe("executeAppCreate", () => {
  test("flag off: creates legacy app with root index.html", async () => {
    const files: Record<string, string> = {};
    let createdParams: Record<string, unknown> | undefined;
    const app = makeLegacyApp();
    const store: AppStore = {
      ...mockStore(app, files),
      createApp: (params) => {
        createdParams = params as unknown as Record<string, unknown>;
        return app;
      },
    };

    const result = await executeAppCreate(
      {
        name: "Test App",
        html: "<html><body>Hello</body></html>",
      },
      store,
    );

    expect(result.isError).toBe(false);
    // Legacy path: no formatVersion set, htmlDefinition is the provided html
    expect(createdParams?.formatVersion).toBeUndefined();
    expect(createdParams?.htmlDefinition).toBe(
      "<html><body>Hello</body></html>",
    );
    // No src/ files should be written
    expect(files["src/index.html"]).toBeUndefined();
    expect(files["src/main.tsx"]).toBeUndefined();
  });

  test("flag on: creates multifile app with src/ scaffold", async () => {
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
        featureFlags: { multifileEnabled: true },
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

  test("flag on with explicit html: uses provided html as src/index.html", async () => {
    const files: Record<string, string> = {};
    const app = makeMultifileApp({ name: "Custom App" });
    const store: AppStore = {
      ...mockStore(app, files),
      createApp: () => app,
    };

    const customHtml =
      '<!DOCTYPE html><html><head></head><body><div id="root"></div></body></html>';
    const result = await executeAppCreate(
      {
        name: "Custom App",
        html: customHtml,
        featureFlags: { multifileEnabled: true },
      },
      store,
    );

    expect(result.isError).toBe(false);
    // Explicit HTML should be used instead of scaffold
    expect(files["src/index.html"]).toBe(customHtml);
    // main.tsx scaffold should still be written
    expect(files["src/main.tsx"]).toBeDefined();
  });
});
