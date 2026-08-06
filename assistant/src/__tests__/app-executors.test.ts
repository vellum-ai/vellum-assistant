import { beforeEach, describe, expect, mock, test } from "bun:test";

type CompileResult = {
  ok: boolean;
  errors: string[];
  warnings: string[];
  durationMs: number;
};

let compileResultOverride: CompileResult = {
  ok: true,
  errors: [],
  warnings: [],
  durationMs: 0,
};

mock.module("../bundler/app-compiler.js", () => ({
  compileApp: async () => compileResultOverride,
}));

beforeEach(() => {
  compileResultOverride = {
    ok: true,
    errors: [],
    warnings: [],
    durationMs: 0,
  };
});

import type { AppDefinition } from "../apps/app-store.js";
import type { AppStore } from "../tools/apps/executors.js";
import {
  executeAppCreate,
  executeAppRefresh,
  executeAppUpdate,
} from "../tools/apps/executors.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
  test("falls back to the preview title when the name is omitted or blank", async () => {
    let createdParams: Record<string, unknown> | undefined;
    const app = makeMultifileApp({ name: "Coffee Tracker" });
    const store: AppStore = {
      ...mockStore(app, {}),
      createApp: (params) => {
        createdParams = params as unknown as Record<string, unknown>;
        return app;
      },
    };

    const result = await executeAppCreate(
      { name: "   ", preview: { title: "Coffee Tracker" } },
      store,
    );

    expect(result.isError).toBe(false);
    expect(createdParams?.name).toBe("Coffee Tracker");
  });

  test("defaults the name to 'New App' when neither name nor preview title is given", async () => {
    let createdParams: Record<string, unknown> | undefined;
    const app = makeMultifileApp({ name: "New App" });
    const store: AppStore = {
      ...mockStore(app, {}),
      createApp: (params) => {
        createdParams = params as unknown as Record<string, unknown>;
        return app;
      },
    };

    const result = await executeAppCreate(
      {} as unknown as Parameters<typeof executeAppCreate>[0],
      store,
    );

    expect(result.isError).toBe(false);
    expect(createdParams?.name).toBe("New App");
  });

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
    // htmlDefinition should be empty — the real source lives under src/
    expect(createdParams?.htmlDefinition).toBe("");
    // Scaffold files should be written
    expect(files["src/index.html"]).toBeDefined();
    expect(files["src/index.html"]).toContain("<title>New App</title>");
    expect(files["src/index.html"]).toContain('<div id="app"></div>');
    expect(files["src/main.tsx"]).toBeDefined();
    expect(files["src/main.tsx"]).toContain("import { render } from 'preact'");
    expect(files["src/main.tsx"]).toContain('{"Hello, New App!"}');
    // next_steps directive must be present so the model keeps writing
    // real source files instead of treating the scaffold as done.
    const parsed = JSON.parse(result.content);
    expect(parsed.next_steps).toContain("placeholder src/main.tsx");
    expect(parsed.next_steps).toContain("app_refresh");
  });

  test("associates the new app with its conversation when a conversationId is given", async () => {
    const app = makeMultifileApp({ id: "app-xyz", name: "Assoc App" });
    const associated: Array<{ appId: string; conversationId: string }> = [];
    const store: AppStore = {
      ...mockStore(app, {}),
      addAppConversationId: (appId, conversationId) => {
        associated.push({ appId, conversationId });
        return true;
      },
    };

    const result = await executeAppCreate(
      { name: "Assoc App" },
      store,
      undefined,
      "conv-assoc-1",
    );

    expect(result.isError).toBe(false);
    expect(associated).toEqual([
      { appId: "app-xyz", conversationId: "conv-assoc-1" },
    ]);
  });

  test("a failed conversation association does not fail the create", async () => {
    const app = makeMultifileApp({ id: "app-throw", name: "Throw App" });
    const store: AppStore = {
      ...mockStore(app, {}),
      addAppConversationId: () => {
        throw new Error("disk gone");
      },
    };

    const result = await executeAppCreate(
      { name: "Throw App" },
      store,
      undefined,
      "conv-assoc-2",
    );

    expect(result.isError).toBe(false);
  });

  test("skips auto_open on scaffold even when proxy resolver is available", async () => {
    const files: Record<string, string> = {};
    const app = makeMultifileApp({ name: "New App" });
    const store: AppStore = {
      ...mockStore(app, files),
      createApp: () => app,
    };
    let proxyCalled = false;
    const proxyResolver = async () => {
      proxyCalled = true;
      return { content: JSON.stringify({ opened: true }), isError: false };
    };

    const result = await executeAppCreate(
      { name: "New App" },
      store,
      proxyResolver,
    );

    expect(result.isError).toBe(false);
    expect(proxyCalled).toBe(false);
    const parsed = JSON.parse(result.content);
    expect(parsed.auto_opened).toBeUndefined();
    expect(parsed.next_steps).toContain("placeholder src/main.tsx");
    expect(parsed.next_steps).toContain("app_refresh");
  });

  test("omits next_steps when main.tsx was pre-written before app_create", async () => {
    // The agent's supported workflow is to write the real source files first
    // and then call app_create. In that case the placeholder directive would
    // be false and risk triggering a destructive rewrite of correct code.
    const files: Record<string, string> = {
      "src/main.tsx": "// real code from the agent",
    };
    const app = makeMultifileApp({ name: "Pre-written App" });
    const store: AppStore = {
      ...mockStore(app, files),
      createApp: () => app,
    };

    const result = await executeAppCreate({ name: "Pre-written App" }, store);

    expect(result.isError).toBe(false);
    // The pre-written file must be preserved
    expect(files["src/main.tsx"]).toBe("// real code from the agent");
    const parsed = JSON.parse(result.content);
    expect(parsed.next_steps).toBeUndefined();
  });

  test("includes next_steps when compile fails on the scaffold", async () => {
    compileResultOverride = {
      ok: false,
      errors: ["unexpected token"],
      warnings: [],
      durationMs: 3,
    };
    const files: Record<string, string> = {};
    const app = makeMultifileApp({ name: "Broken App" });
    const store: AppStore = {
      ...mockStore(app, files),
      createApp: () => app,
    };

    const result = await executeAppCreate({ name: "Broken App" }, store);

    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.content);
    expect(parsed.compile_errors).toEqual(["unexpected token"]);
    expect(parsed.next_steps).toContain("placeholder src/main.tsx");
    expect(parsed.next_steps).toContain("app_refresh");
  });

  test("omits next_steps when compile fails on pre-written files", async () => {
    compileResultOverride = {
      ok: false,
      errors: ["unexpected token"],
      warnings: [],
      durationMs: 3,
    };
    const files: Record<string, string> = {
      "src/main.tsx": "// agent's real (but broken) code",
    };
    const app = makeMultifileApp({ name: "Broken Pre-written App" });
    const store: AppStore = {
      ...mockStore(app, files),
      createApp: () => app,
    };

    const result = await executeAppCreate(
      { name: "Broken Pre-written App" },
      store,
    );

    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.content);
    expect(parsed.compile_errors).toEqual(["unexpected token"]);
    expect(parsed.next_steps).toBeUndefined();
  });

  test("suppresses auto_open when only scaffold exists", async () => {
    const files: Record<string, string> = {};
    const app = makeMultifileApp({ name: "New App" });
    const store: AppStore = {
      ...mockStore(app, files),
      createApp: () => app,
    };
    let proxyCalledWith: Record<string, unknown> | undefined;
    const proxyResolver = async (
      toolName: string,
      input: Record<string, unknown>,
    ) => {
      proxyCalledWith = { toolName, input };
      return { content: JSON.stringify({ opened: true }), isError: false };
    };

    const result = await executeAppCreate(
      { name: "New App" },
      store,
      proxyResolver,
    );

    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.content);
    expect(proxyCalledWith).toBeUndefined();
    expect(parsed.auto_opened).toBeUndefined();
    expect(parsed.next_steps).toContain("placeholder src/main.tsx");
  });

  test("fires auto_open when source_files includes main.tsx", async () => {
    const files: Record<string, string> = {};
    const app = makeMultifileApp({ name: "Real App" });
    const store: AppStore = {
      ...mockStore(app, files),
      createApp: () => app,
    };
    let proxyCalledWith: Record<string, unknown> | undefined;
    const proxyResolver = async (
      toolName: string,
      input: Record<string, unknown>,
    ) => {
      proxyCalledWith = { toolName, input };
      return { content: JSON.stringify({ opened: true }), isError: false };
    };

    const result = await executeAppCreate(
      {
        name: "Real App",
        source_files: {
          "src/main.tsx":
            "import { render } from 'preact';\nrender(<div>Real</div>, document.getElementById('app')!);",
          "src/styles.css": "body { margin: 0; }",
        },
      },
      store,
      proxyResolver,
    );

    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.content);
    expect(proxyCalledWith).toBeDefined();
    expect(parsed.auto_opened).toBe(true);
    expect(parsed.next_steps).toBeUndefined();
    expect(files["src/main.tsx"]).toContain("Real");
    expect(files["src/styles.css"]).toContain("margin");
  });

  test("source_files are written and prevent scaffold", async () => {
    const files: Record<string, string> = {};
    const app = makeMultifileApp({ name: "Inline App" });
    const store: AppStore = {
      ...mockStore(app, files),
      createApp: () => app,
    };

    const result = await executeAppCreate(
      {
        name: "Inline App",
        source_files: {
          "src/main.tsx": "// custom app code",
          "src/components/App.tsx": "// App component",
        },
      },
      store,
    );

    expect(result.isError).toBe(false);
    expect(files["src/main.tsx"]).toBe("// custom app code");
    expect(files["src/components/App.tsx"]).toBe("// App component");
    expect(files["src/index.html"]).toBeDefined();
    const parsed = JSON.parse(result.content);
    expect(parsed.next_steps).toBeUndefined();
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
    const app = makeMultifileApp();
    const store = mockStore(app);
    const result = await executeAppRefresh({ app_id: "nonexistent" }, store);

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content);
    expect(parsed.error).toContain("not found");
  });
});

// ---------------------------------------------------------------------------
// executeAppUpdate
// ---------------------------------------------------------------------------

describe("executeAppUpdate", () => {
  test("updates metadata and recompiles a multifile app", async () => {
    const app = makeMultifileApp({ name: "Old", description: "old desc" });
    let updateArgs: unknown;
    const store: AppStore = {
      ...mockStore(app),
      updateApp: (_id, updates) => {
        updateArgs = updates;
        return { ...app, ...updates };
      },
    };

    const result = await executeAppUpdate(
      { app_id: app.id, name: "New Name", description: "new desc" },
      store,
    );

    expect(result.isError).toBe(false);
    expect(updateArgs).toEqual({ name: "New Name", description: "new desc" });
    const parsed = JSON.parse(result.content);
    expect(parsed.updated).toBe(true);
    expect(parsed.name).toBe("New Name");
    expect(parsed.description).toBe("new desc");
    expect(parsed.compiled).toBe(true);
  });

  test("writes source_files before recompiling", async () => {
    const files: Record<string, string> = {};
    const app = makeMultifileApp();
    const store: AppStore = {
      ...mockStore(app, files),
      updateApp: (_id, updates) => ({ ...app, ...updates }),
    };

    const result = await executeAppUpdate(
      { app_id: app.id, source_files: { "src/App.tsx": "// new code" } },
      store,
    );

    expect(result.isError).toBe(false);
    expect(files["src/App.tsx"]).toBe("// new code");
    expect(JSON.parse(result.content).compiled).toBe(true);
  });

  test("returns error for unknown app", async () => {
    const store = mockStore(makeMultifileApp());
    const result = await executeAppUpdate({ app_id: "nope" }, store);

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content).error).toContain("not found");
  });

  test("rejects invalid source_files", async () => {
    const app = makeMultifileApp();
    const store = mockStore(app);
    const result = await executeAppUpdate(
      {
        app_id: app.id,
        source_files: { "src/App.tsx": 123 as unknown as string },
      },
      store,
    );

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content).error).toContain("must be a string");
  });
});
