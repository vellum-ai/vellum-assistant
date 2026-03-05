import { describe, expect, test } from "bun:test";

import type { AppDefinition } from "../memory/app-store.js";
import type { AppStore, ProxyResolver } from "../tools/apps/executors.js";
import {
  executeAppCreate,
  executeAppDelete,
  executeAppFileEdit,
  executeAppFileList,
  executeAppFileRead,
  executeAppFileWrite,
  executeAppList,
  executeAppQuery,
  executeAppUpdate,
} from "../tools/apps/executors.js";
import type { EditEngineResult } from "../tools/shared/filesystem/edit-engine.js";

// ---------------------------------------------------------------------------
// Mock factory
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

// ---------------------------------------------------------------------------
// app_create
// ---------------------------------------------------------------------------

describe("executeAppCreate", () => {
  test("creates an app and returns its definition", async () => {
    const store = makeMockStore();
    const result = await executeAppCreate(
      { name: "My App", html: "<p>Hello</p>" },
      store,
    );
    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.content);
    expect(parsed.name).toBe("My App");
  });

  test('defaults schema_json to "{}" when not provided', async () => {
    let capturedSchema: string | undefined;
    const store = makeMockStore({
      createApp: (params) => {
        capturedSchema = params.schemaJson;
        return makeApp({ name: params.name });
      },
    });
    await executeAppCreate({ name: "App", html: "<p/>" }, store);
    expect(capturedSchema).toBe("{}");
  });

  test("passes schema_json through when provided", async () => {
    let capturedSchema: string | undefined;
    const store = makeMockStore({
      createApp: (params) => {
        capturedSchema = params.schemaJson;
        return makeApp({ name: params.name });
      },
    });
    await executeAppCreate(
      { name: "App", html: "<p/>", schema_json: '{"type":"object"}' },
      store,
    );
    expect(capturedSchema).toBe('{"type":"object"}');
  });

  test("auto-opens the app when proxyToolResolver is provided", async () => {
    const store = makeMockStore();
    const proxy: ProxyResolver = async () => ({
      content: "opened",
      isError: false,
    });
    const result = await executeAppCreate(
      { name: "Auto", html: "<p/>" },
      store,
      proxy,
    );
    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.content);
    expect(parsed.auto_opened).toBe(true);
    expect(parsed.open_result).toBe("opened");
  });

  test("returns auto_opened=false when proxy resolver throws", async () => {
    const store = makeMockStore();
    const proxy: ProxyResolver = async () => {
      throw new Error("no client");
    };
    const result = await executeAppCreate(
      { name: "Fail Open", html: "<p/>" },
      store,
      proxy,
    );
    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.content);
    expect(parsed.auto_opened).toBe(false);
    expect(parsed.auto_open_error).toBe(
      "Failed to auto-open app. Use app_open to open it manually.",
    );
  });

  test("skips auto-open when auto_open is false", async () => {
    let proxyCalled = false;
    const store = makeMockStore();
    const proxy: ProxyResolver = async () => {
      proxyCalled = true;
      return { content: "opened", isError: false };
    };
    const result = await executeAppCreate(
      { name: "No Open", html: "<p/>", auto_open: false },
      store,
      proxy,
    );
    expect(proxyCalled).toBe(false);
    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.content);
    expect(parsed.auto_opened).toBeUndefined();
  });

  test("skips auto-open when no proxyToolResolver", async () => {
    const store = makeMockStore();
    const result = await executeAppCreate(
      { name: "No Proxy", html: "<p/>" },
      store,
    );
    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.content);
    expect(parsed.auto_opened).toBeUndefined();
  });

  test("passes pages through to store.createApp", async () => {
    let capturedPages: Record<string, string> | undefined;
    const store = makeMockStore({
      createApp: (params) => {
        capturedPages = params.pages;
        return makeApp({ name: params.name });
      },
    });
    await executeAppCreate(
      { name: "Multi", html: "<p/>", pages: { "settings.html": "<div/>" } },
      store,
    );
    expect(capturedPages).toEqual({ "settings.html": "<div/>" });
  });

  test("defaults html to minimal scaffold when omitted", async () => {
    let capturedHtml: string | undefined;
    const store = makeMockStore({
      createApp: (params) => {
        capturedHtml = params.htmlDefinition;
        return makeApp({ name: params.name });
      },
    });
    await executeAppCreate({ name: "No HTML" }, store);
    expect(capturedHtml).toBe(
      "<!DOCTYPE html><html><head></head><body></body></html>",
    );
  });
});

// ---------------------------------------------------------------------------
// app_list
// ---------------------------------------------------------------------------

describe("executeAppList", () => {
  test("returns mapped list of apps", () => {
    const store = makeMockStore({
      listApps: () => [
        makeApp({
          id: "a1",
          name: "First",
          description: "desc1",
          updatedAt: 100,
        }),
        makeApp({ id: "a2", name: "Second", updatedAt: 200 }),
      ],
    });
    const result = executeAppList(store);
    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.content);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toEqual({
      id: "a1",
      name: "First",
      description: "desc1",
      updatedAt: 100,
    });
    expect(parsed[1].id).toBe("a2");
    // Should not include htmlDefinition or schemaJson
    expect(parsed[0].htmlDefinition).toBeUndefined();
    expect(parsed[0].schemaJson).toBeUndefined();
  });

  test("returns empty array when no apps exist", () => {
    const store = makeMockStore({ listApps: () => [] });
    const result = executeAppList(store);
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// app_query
// ---------------------------------------------------------------------------

describe("executeAppQuery", () => {
  test("returns records for a given app", () => {
    const records = [{ id: "r1", appId: "app-1", data: { x: 1 } }];
    const store = makeMockStore({ queryAppRecords: () => records });
    const result = executeAppQuery({ app_id: "app-1" }, store);
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content)).toEqual(records);
  });

  test("returns empty array when no records", () => {
    const store = makeMockStore({ queryAppRecords: () => [] });
    const result = executeAppQuery({ app_id: "app-1" }, store);
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// app_update
// ---------------------------------------------------------------------------

describe("executeAppUpdate", () => {
  test("passes update fields through to store", () => {
    let capturedUpdates: Record<string, unknown> = {};
    const store = makeMockStore({
      updateApp: (_id, updates) => {
        capturedUpdates = updates;
        return makeApp({ id: _id, ...updates });
      },
    });
    const result = executeAppUpdate(
      {
        app_id: "app-1",
        name: "New Name",
        description: "New desc",
        schema_json: '{"a":1}',
        html: "<div/>",
        pages: { "about.html": "<p/>" },
      },
      store,
    );
    expect(result.isError).toBe(false);
    expect(capturedUpdates).toEqual({
      name: "New Name",
      description: "New desc",
      schemaJson: '{"a":1}',
      htmlDefinition: "<div/>",
      pages: { "about.html": "<p/>" },
    });
  });

  test("only includes provided fields in updates", () => {
    let capturedUpdates: Record<string, unknown> = {};
    const store = makeMockStore({
      updateApp: (_id, updates) => {
        capturedUpdates = updates;
        return makeApp({ id: _id, ...updates });
      },
    });
    executeAppUpdate({ app_id: "app-1", name: "Only Name" }, store);
    expect(capturedUpdates).toEqual({ name: "Only Name" });
    // html, description, schema_json, pages should NOT be in the updates
    expect("htmlDefinition" in capturedUpdates).toBe(false);
    expect("description" in capturedUpdates).toBe(false);
    expect("schemaJson" in capturedUpdates).toBe(false);
    expect("pages" in capturedUpdates).toBe(false);
  });

  test("propagates store errors", () => {
    const store = makeMockStore({
      updateApp: () => {
        throw new Error("App not found: bad-id");
      },
    });
    expect(() => executeAppUpdate({ app_id: "bad-id" }, store)).toThrow(
      "App not found: bad-id",
    );
  });
});

// ---------------------------------------------------------------------------
// app_delete
// ---------------------------------------------------------------------------

describe("executeAppDelete", () => {
  test("deletes the app and returns confirmation", () => {
    let deletedId: string | undefined;
    const store = makeMockStore({
      deleteApp: (id) => {
        deletedId = id;
      },
    });
    const result = executeAppDelete({ app_id: "app-1" }, store);
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content)).toEqual({
      deleted: true,
      appId: "app-1",
    });
    expect(deletedId).toBe("app-1");
  });
});

// ---------------------------------------------------------------------------
// app_file_list
// ---------------------------------------------------------------------------

describe("executeAppFileList", () => {
  test("returns list of files", () => {
    const store = makeMockStore({
      listAppFiles: () => ["index.html", "styles.css", "js/app.js"],
    });
    const result = executeAppFileList({ app_id: "app-1" }, store);
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content)).toEqual([
      "index.html",
      "styles.css",
      "js/app.js",
    ]);
  });

  test("returns empty array when app has no files", () => {
    const store = makeMockStore({ listAppFiles: () => [] });
    const result = executeAppFileList({ app_id: "app-1" }, store);
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// app_file_read
// ---------------------------------------------------------------------------

describe("executeAppFileRead", () => {
  test("returns formatted content with line numbers", () => {
    const store = makeMockStore({
      readAppFile: () => "line1\nline2\nline3",
    });
    const result = executeAppFileRead(
      { app_id: "app-1", path: "index.html" },
      store,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toBe("     1\tline1\n     2\tline2\n     3\tline3");
  });

  test("applies offset parameter (1-based)", () => {
    const store = makeMockStore({
      readAppFile: () => "a\nb\nc\nd\ne",
    });
    const result = executeAppFileRead(
      { app_id: "app-1", path: "f.txt", offset: 3 },
      store,
    );
    expect(result.isError).toBe(false);
    // Lines 3, 4, 5
    expect(result.content).toBe("     3\tc\n     4\td\n     5\te");
  });

  test("applies limit parameter", () => {
    const store = makeMockStore({
      readAppFile: () => "a\nb\nc\nd\ne",
    });
    const result = executeAppFileRead(
      { app_id: "app-1", path: "f.txt", limit: 2 },
      store,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toBe("     1\ta\n     2\tb");
  });

  test("applies both offset and limit", () => {
    const store = makeMockStore({
      readAppFile: () => "a\nb\nc\nd\ne",
    });
    const result = executeAppFileRead(
      { app_id: "app-1", path: "f.txt", offset: 2, limit: 2 },
      store,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toBe("     2\tb\n     3\tc");
  });

  test("defaults offset to 1 when not provided", () => {
    const store = makeMockStore({
      readAppFile: () => "only",
    });
    const result = executeAppFileRead(
      { app_id: "app-1", path: "f.txt" },
      store,
    );
    expect(result.content).toBe("     1\tonly");
  });

  test("propagates store errors (e.g. file not found)", () => {
    const store = makeMockStore({
      readAppFile: () => {
        throw new Error("File not found: missing.txt");
      },
    });
    expect(() =>
      executeAppFileRead({ app_id: "app-1", path: "missing.txt" }, store),
    ).toThrow("File not found: missing.txt");
  });
});

// ---------------------------------------------------------------------------
// app_file_edit
// ---------------------------------------------------------------------------

describe("executeAppFileEdit", () => {
  test("returns edit result from store", () => {
    const editResult: EditEngineResult = {
      ok: true,
      updatedContent: "updated",
      matchCount: 1,
      matchMethod: "exact" as const,
      similarity: 1,
      actualOld: "old",
      actualNew: "new",
    };
    const store = makeMockStore({ editAppFile: () => editResult });
    const result = executeAppFileEdit(
      {
        app_id: "app-1",
        path: "index.html",
        old_string: "old",
        new_string: "new",
      },
      store,
    );
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content)).toEqual(editResult);
  });

  test("returns error when old_string is empty", () => {
    const store = makeMockStore();
    const result = executeAppFileEdit(
      {
        app_id: "app-1",
        path: "index.html",
        old_string: "",
        new_string: "new",
      },
      store,
    );
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content)).toEqual({
      error: "old_string must not be empty",
    });
  });

  test("passes replace_all through to store", () => {
    let capturedReplaceAll: boolean | undefined;
    const store = makeMockStore({
      editAppFile: (_appId, _path, _old, _new, replaceAll) => {
        capturedReplaceAll = replaceAll;
        return {
          ok: true,
          updatedContent: "",
          matchCount: 1,
          matchMethod: "exact" as const,
          similarity: 1,
          actualOld: "",
          actualNew: "",
        };
      },
    });
    executeAppFileEdit(
      {
        app_id: "app-1",
        path: "f.txt",
        old_string: "x",
        new_string: "y",
        replace_all: true,
      },
      store,
    );
    expect(capturedReplaceAll).toBe(true);
  });

  test("defaults replace_all to false", () => {
    let capturedReplaceAll: boolean | undefined;
    const store = makeMockStore({
      editAppFile: (_appId, _path, _old, _new, replaceAll) => {
        capturedReplaceAll = replaceAll;
        return {
          ok: true,
          updatedContent: "",
          matchCount: 1,
          matchMethod: "exact" as const,
          similarity: 1,
          actualOld: "",
          actualNew: "",
        };
      },
    });
    executeAppFileEdit(
      {
        app_id: "app-1",
        path: "f.txt",
        old_string: "x",
        new_string: "y",
      },
      store,
    );
    expect(capturedReplaceAll).toBe(false);
  });

  test("passes status through to result", () => {
    const store = makeMockStore();
    const result = executeAppFileEdit(
      {
        app_id: "app-1",
        path: "f.txt",
        old_string: "x",
        new_string: "y",
        status: "updating styles",
      },
      store,
    );
    expect(result.status).toBe("updating styles");
  });
});

// ---------------------------------------------------------------------------
// app_file_write
// ---------------------------------------------------------------------------

describe("executeAppFileWrite", () => {
  test("writes file and returns confirmation", () => {
    let writtenPath: string | undefined;
    let writtenContent: string | undefined;
    const store = makeMockStore({
      writeAppFile: (_appId, path, content) => {
        writtenPath = path;
        writtenContent = content;
      },
    });
    const result = executeAppFileWrite(
      { app_id: "app-1", path: "new.html", content: "<div/>" },
      store,
    );
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content)).toEqual({
      written: true,
      path: "new.html",
    });
    expect(writtenPath).toBe("new.html");
    expect(writtenContent).toBe("<div/>");
  });

  test("returns error when app is not found", () => {
    const store = makeMockStore({ getApp: () => null });
    const result = executeAppFileWrite(
      { app_id: "missing", path: "f.txt", content: "hi" },
      store,
    );
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content)).toEqual({
      error: "App 'missing' not found",
    });
  });

  test("passes status through to result", () => {
    const store = makeMockStore();
    const result = executeAppFileWrite(
      {
        app_id: "app-1",
        path: "f.txt",
        content: "hi",
        status: "adding dark mode styles",
      },
      store,
    );
    expect(result.status).toBe("adding dark mode styles");
  });

  test("does not call writeAppFile when app not found", () => {
    let writeCalled = false;
    const store = makeMockStore({
      getApp: () => null,
      writeAppFile: () => {
        writeCalled = true;
      },
    });
    executeAppFileWrite({ app_id: "bad", path: "f.txt", content: "x" }, store);
    expect(writeCalled).toBe(false);
  });
});
