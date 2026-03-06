import { describe, expect, test } from "bun:test";

import type { AppDefinition } from "../memory/app-store.js";
import type { AppStore } from "../tools/apps/executors.js";
import {
  executeAppCreate,
  executeAppFileEdit,
  executeAppFileList,
  executeAppFileRead,
  executeAppFileWrite,
  resolveAppFilePath,
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
// resolveAppFilePath
// ---------------------------------------------------------------------------

describe("resolveAppFilePath", () => {
  test("prepends src/ for multifile app with plain path", () => {
    const app = makeMultifileApp();
    expect(resolveAppFilePath(app, "main.tsx")).toBe("src/main.tsx");
  });

  test("prepends src/ for nested path in multifile app", () => {
    const app = makeMultifileApp();
    expect(resolveAppFilePath(app, "components/Header.tsx")).toBe(
      "src/components/Header.tsx",
    );
  });

  test("passes through src/ prefix unchanged for multifile app", () => {
    const app = makeMultifileApp();
    expect(resolveAppFilePath(app, "src/main.tsx")).toBe("src/main.tsx");
  });

  test("passes through dist/ prefix unchanged for multifile app", () => {
    const app = makeMultifileApp();
    expect(resolveAppFilePath(app, "dist/bundle.js")).toBe("dist/bundle.js");
  });

  test("passes through records/ prefix unchanged for multifile app", () => {
    const app = makeMultifileApp();
    expect(resolveAppFilePath(app, "records/data.json")).toBe(
      "records/data.json",
    );
  });

  test("does not modify path for legacy app", () => {
    const app = makeLegacyApp();
    expect(resolveAppFilePath(app, "main.tsx")).toBe("main.tsx");
  });

  test("does not modify path for legacy app (formatVersion undefined)", () => {
    const app = makeLegacyApp({ formatVersion: undefined });
    expect(resolveAppFilePath(app, "styles.css")).toBe("styles.css");
  });

  test("does not modify path for legacy app (formatVersion 1)", () => {
    const app = makeLegacyApp({ formatVersion: 1 });
    expect(resolveAppFilePath(app, "index.html")).toBe("index.html");
  });
});

// ---------------------------------------------------------------------------
// executeAppFileWrite
// ---------------------------------------------------------------------------

describe("executeAppFileWrite", () => {
  test("resolves plain path to src/ for multifile app", () => {
    const files: Record<string, string> = {};
    const app = makeMultifileApp();
    const store = mockStore(app, files);

    const result = executeAppFileWrite(
      { app_id: app.id, path: "main.tsx", content: "export default 1;" },
      store,
    );

    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content).path).toBe("src/main.tsx");
    expect(files["src/main.tsx"]).toBe("export default 1;");
  });

  test("passes through src/ path unchanged for multifile app", () => {
    const files: Record<string, string> = {};
    const app = makeMultifileApp();
    const store = mockStore(app, files);

    const result = executeAppFileWrite(
      { app_id: app.id, path: "src/main.tsx", content: "export default 2;" },
      store,
    );

    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content).path).toBe("src/main.tsx");
    expect(files["src/main.tsx"]).toBe("export default 2;");
  });

  test("does not modify path for legacy app", () => {
    const files: Record<string, string> = {};
    const app = makeLegacyApp();
    const store = mockStore(app, files);

    const result = executeAppFileWrite(
      { app_id: app.id, path: "index.html", content: "<html></html>" },
      store,
    );

    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content).path).toBe("index.html");
    expect(files["index.html"]).toBe("<html></html>");
  });
});

// ---------------------------------------------------------------------------
// executeAppFileRead
// ---------------------------------------------------------------------------

describe("executeAppFileRead", () => {
  test("resolves plain path to src/ for multifile app", () => {
    const app = makeMultifileApp();
    const store = mockStore(app, { "src/main.tsx": "line1\nline2" });

    const result = executeAppFileRead(
      { app_id: app.id, path: "main.tsx" },
      store,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("line1");
  });

  test("can read dist/ files explicitly for multifile app", () => {
    const app = makeMultifileApp();
    const store = mockStore(app, { "dist/bundle.js": "bundled code" });

    const result = executeAppFileRead(
      { app_id: app.id, path: "dist/bundle.js" },
      store,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("bundled code");
  });

  test("does not modify path for legacy app", () => {
    const app = makeLegacyApp();
    const store = mockStore(app, { "index.html": "<html>hello</html>" });

    const result = executeAppFileRead(
      { app_id: app.id, path: "index.html" },
      store,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("<html>hello</html>");
  });
});

// ---------------------------------------------------------------------------
// executeAppFileEdit
// ---------------------------------------------------------------------------

describe("executeAppFileEdit", () => {
  test("resolves plain path to src/ for multifile app", () => {
    const files = { "src/main.tsx": "const x = 1;" };
    const app = makeMultifileApp();
    const store = mockStore(app, files);

    const result = executeAppFileEdit(
      {
        app_id: app.id,
        path: "main.tsx",
        old_string: "const x = 1;",
        new_string: "const x = 2;",
      },
      store,
    );

    expect(result.isError).toBe(false);
    expect(files["src/main.tsx"]).toBe("const x = 2;");
  });

  test("does not modify path for legacy app", () => {
    const files = { "index.html": "<p>old</p>" };
    const app = makeLegacyApp();
    const store = mockStore(app, files);

    const result = executeAppFileEdit(
      {
        app_id: app.id,
        path: "index.html",
        old_string: "<p>old</p>",
        new_string: "<p>new</p>",
      },
      store,
    );

    expect(result.isError).toBe(false);
    expect(files["index.html"]).toBe("<p>new</p>");
  });
});

// ---------------------------------------------------------------------------
// executeAppFileList
// ---------------------------------------------------------------------------

describe("executeAppFileList", () => {
  test("annotates dist/ files as build output for multifile app", () => {
    const app = makeMultifileApp();
    const store = mockStore(app, {
      "src/main.tsx": "",
      "src/components/Header.tsx": "",
      "dist/index.html": "",
    });

    const result = executeAppFileList({ app_id: app.id }, store);
    const parsed = JSON.parse(result.content) as string[];

    expect(parsed).toContain("src/main.tsx");
    expect(parsed).toContain("src/components/Header.tsx");
    expect(parsed).toContain("dist/index.html [build output]");
  });

  test("does not annotate files for legacy app", () => {
    const app = makeLegacyApp();
    const store = mockStore(app, {
      "index.html": "",
      "styles.css": "",
    });

    const result = executeAppFileList({ app_id: app.id }, store);
    const parsed = JSON.parse(result.content) as string[];

    expect(parsed).toContain("index.html");
    expect(parsed).toContain("styles.css");
    expect(parsed.every((f: string) => !f.includes("[build output]"))).toBe(
      true,
    );
  });
});

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
    expect(files["src/main.tsx"]).toContain("Hello, New App!");
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
