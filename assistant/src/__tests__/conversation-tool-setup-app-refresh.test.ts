/**
 * Regression tests for app surface refresh and eventing side effects in
 * createToolExecutor (conversation-tool-setup.ts).
 *
 * After the App Builder tools source swap (PR 8), app tools like app_update,
 * app_file_edit, and app_file_write are provided by the app-builder skill
 * rather than core registration. The afterExecute hooks in createToolExecutor
 * fire based on tool *name* matching, so they must continue to work for
 * skill-origin tools. These tests verify that contract.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { ToolSetupContext } from "../daemon/conversation-tool-setup.js";
import type { SurfaceData, SurfaceType } from "../daemon/message-protocol.js";
import type { PermissionPrompter } from "../permissions/prompter.js";
import type { SecretPrompter } from "../permissions/secret-prompter.js";
import type { ToolExecutor } from "../tools/executor.js";
import type { ToolExecutionResult } from "../tools/types.js";

// ---------------------------------------------------------------------------
// Spies for side-effect verification
// ---------------------------------------------------------------------------

const refreshSpy = mock(() => {});
const updatePublishedSpy = mock(() => Promise.resolve());
const generateAppIconMock = mock(() => Promise.resolve());
const compileAppMock = mock(
  async (): Promise<{
    ok: boolean;
    errors: Array<{ text: string }>;
    warnings: Array<{ text: string }>;
    durationMs: number;
    builtAt: number;
  }> => ({
    ok: true,
    errors: [],
    warnings: [],
    durationMs: 12,
    builtAt: Date.now(),
  }),
);
const getAppMock = mock(
  (): { id: string; formatVersion?: number } | null => null,
);
const isMultifileAppMock = mock((app: { formatVersion?: number } | null) => {
  return app?.formatVersion === 2;
});
const getAppsDirMock = mock(() => "/fake/apps");

// Mock session-surfaces so refreshSurfacesForApp is captured
mock.module("../daemon/conversation-surfaces.js", () => ({
  refreshSurfacesForApp: refreshSpy,
  surfaceProxyResolver: mock(() =>
    Promise.resolve({ content: "", isError: false }),
  ),
}));

// Mock published-app-updater to prevent real deployment calls
mock.module("../services/published-app-updater.js", () => ({
  updatePublishedAppDeployment: updatePublishedSpy,
}));

mock.module("../media/app-icon-generator.js", () => ({
  generateAppIcon: generateAppIconMock,
}));

mock.module("../bundler/app-compiler.js", () => ({
  compileApp: compileAppMock,
  formatCompileStatusMessage: (result: {
    ok: boolean;
    errors: Array<{ text: string }>;
  }) => {
    if (result.ok) return undefined;
    const firstError = result.errors[0]?.text ?? "Build failed";
    return `Build failed: ${firstError}`;
  },
}));

mock.module("../memory/app-store.js", () => ({
  getApp: getAppMock,
  getAppsDir: getAppsDirMock,
  isMultifileApp: isMultifileAppMock,
}));

// Mock browser-screencast registration (no-op)
mock.module("../tools/browser/browser-screencast.js", () => ({
  registerConversationSender: mock(() => {}),
}));

// ---------------------------------------------------------------------------
// Import createToolExecutor after mocks are in place
// ---------------------------------------------------------------------------

import { createToolExecutor } from "../daemon/conversation-tool-setup.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal ToolSetupContext stub. */
function makeCtx(overrides: Partial<ToolSetupContext> = {}): ToolSetupContext {
  return {
    conversationId: "conv-test",
    currentRequestId: "req-1",
    workingDir: "/tmp/test",
    abortController: null,
    traceEmitter: { emit: () => {} },
    sendToClient: mock(() => {}),
    pendingSurfaceActions: new Map(),
    lastSurfaceAction: new Map(),
    surfaceState: new Map<
      string,
      { surfaceType: SurfaceType; data: SurfaceData; title?: string }
    >(),
    surfaceUndoStacks: new Map(),
    surfaceActionRequestIds: new Set<string>(),
    currentTurnSurfaces: [],
    isProcessing: () => false,
    enqueueMessage: () => ({ queued: false, requestId: "r" }),
    getQueueDepth: () => 0,
    processMessage: async () => "",
    withSurface: async <T>(_id: string, fn: () => T | Promise<T>) => fn(),
    memoryPolicy: { scopeId: "default", strictSideEffects: false },
    ...overrides,
  };
}

/** Fake ToolExecutor whose execute() returns a controlled result. */
function makeFakeExecutor(
  result: ToolExecutionResult = { content: "{}", isError: false },
) {
  return {
    execute: mock(async () => result),
  };
}

/** No-op prompter stubs. */
const noopPrompter = {
  prompt: mock(async () => ({ decision: "allow" as const })),
} as unknown as PermissionPrompter;
const noopSecretPrompter = {
  prompt: mock(async () => ({ cancelled: true })),
} as unknown as SecretPrompter;
const noopLifecycleHandler = mock(() => {});

async function flushAsyncSideEffects(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("session-tool-setup app refresh side effects", () => {
  beforeEach(() => {
    refreshSpy.mockClear();
    updatePublishedSpy.mockClear();
    generateAppIconMock.mockClear();
    compileAppMock.mockClear();
    compileAppMock.mockImplementation(async () => ({
      ok: true,
      errors: [],
      warnings: [],
      durationMs: 12,
      builtAt: Date.now(),
    }));
    getAppMock.mockClear();
    getAppMock.mockReturnValue(null);
    isMultifileAppMock.mockClear();
    isMultifileAppMock.mockImplementation(
      (app: { formatVersion?: number } | null) => app?.formatVersion === 2,
    );
    getAppsDirMock.mockClear();
    getAppsDirMock.mockReturnValue("/fake/apps");
  });

  // ── app_update ──────────────────────────────────────────────────────

  describe("app_update", () => {
    test("triggers refreshSurfacesForApp when result is not an error", async () => {
      const ctx = makeCtx();
      const executor = makeFakeExecutor({
        content: '{"id":"app-1"}',
        isError: false,
      });
      const broadcastSpy = mock(() => {});

      const toolFn = createToolExecutor(
        executor as unknown as ToolExecutor,
        noopPrompter,
        noopSecretPrompter,
        ctx,
        noopLifecycleHandler,
        broadcastSpy,
      );

      await toolFn("app_update", { app_id: "app-1", name: "New Name" });

      expect(refreshSpy).toHaveBeenCalledTimes(1);
      expect((refreshSpy.mock.calls as unknown[][])[0][0]).toBe(ctx);
      expect((refreshSpy.mock.calls as unknown[][])[0][1]).toBe("app-1");
    });

    test("broadcasts app_files_changed with correct appId", async () => {
      const ctx = makeCtx();
      const executor = makeFakeExecutor({ content: "{}", isError: false });
      const broadcastSpy = mock(() => {});

      const toolFn = createToolExecutor(
        executor as unknown as ToolExecutor,
        noopPrompter,
        noopSecretPrompter,
        ctx,
        noopLifecycleHandler,
        broadcastSpy,
      );

      await toolFn("app_update", { app_id: "app-42" });

      expect(broadcastSpy).toHaveBeenCalledTimes(1);
      expect((broadcastSpy.mock.calls as unknown[][])[0][0]).toEqual({
        type: "app_files_changed",
        appId: "app-42",
      });
    });

    test("calls updatePublishedAppDeployment", async () => {
      const ctx = makeCtx();
      const executor = makeFakeExecutor({ content: "{}", isError: false });

      const toolFn = createToolExecutor(
        executor as unknown as ToolExecutor,
        noopPrompter,
        noopSecretPrompter,
        ctx,
        noopLifecycleHandler,
        mock(() => {}),
      );

      await toolFn("app_update", { app_id: "app-publish" });

      // updatePublishedAppDeployment is called with void (fire-and-forget),
      // so just verify it was invoked.
      expect(updatePublishedSpy).toHaveBeenCalledTimes(1);
      expect((updatePublishedSpy.mock.calls as unknown[][])[0][0]).toBe(
        "app-publish",
      );
    });

    test("skips side effects when result is an error", async () => {
      const ctx = makeCtx();
      const executor = makeFakeExecutor({
        content: "Error: not found",
        isError: true,
      });
      const broadcastSpy = mock(() => {});

      const toolFn = createToolExecutor(
        executor as unknown as ToolExecutor,
        noopPrompter,
        noopSecretPrompter,
        ctx,
        noopLifecycleHandler,
        broadcastSpy,
      );

      await toolFn("app_update", { app_id: "app-err" });

      expect(refreshSpy).not.toHaveBeenCalled();
      expect(broadcastSpy).not.toHaveBeenCalled();
      expect(updatePublishedSpy).not.toHaveBeenCalled();
    });

    test("skips side effects when app_id is missing", async () => {
      const ctx = makeCtx();
      const executor = makeFakeExecutor({ content: "{}", isError: false });
      const broadcastSpy = mock(() => {});

      const toolFn = createToolExecutor(
        executor as unknown as ToolExecutor,
        noopPrompter,
        noopSecretPrompter,
        ctx,
        noopLifecycleHandler,
        broadcastSpy,
      );

      await toolFn("app_update", {});

      expect(refreshSpy).not.toHaveBeenCalled();
      expect(broadcastSpy).not.toHaveBeenCalled();
    });
  });

  // ── app_file_edit ───────────────────────────────────────────────────

  describe("app_file_edit", () => {
    test("triggers refreshSurfacesForApp with fileChange flag", async () => {
      const ctx = makeCtx();
      const executor = makeFakeExecutor({
        content: '{"ok":true}',
        isError: false,
      });
      const broadcastSpy = mock(() => {});

      const toolFn = createToolExecutor(
        executor as unknown as ToolExecutor,
        noopPrompter,
        noopSecretPrompter,
        ctx,
        noopLifecycleHandler,
        broadcastSpy,
      );

      await toolFn("app_file_edit", {
        app_id: "app-edit",
        path: "index.html",
        old_string: "old",
        new_string: "new",
      });

      expect(refreshSpy).toHaveBeenCalledTimes(1);
      expect((refreshSpy.mock.calls as unknown[][])[0][1]).toBe("app-edit");
      // Verify opts include fileChange: true
      expect((refreshSpy.mock.calls as unknown[][])[0][2]).toEqual({
        fileChange: true,
        status: undefined,
      });
    });

    test("propagates status field through refresh opts", async () => {
      const ctx = makeCtx();
      const executor = makeFakeExecutor({
        content: '{"ok":true}',
        isError: false,
      });

      const toolFn = createToolExecutor(
        executor as unknown as ToolExecutor,
        noopPrompter,
        noopSecretPrompter,
        ctx,
        noopLifecycleHandler,
        mock(() => {}),
      );

      await toolFn("app_file_edit", {
        app_id: "app-status",
        path: "styles.css",
        old_string: "x",
        new_string: "y",
        status: "updating styles",
      });

      expect(refreshSpy).toHaveBeenCalledTimes(1);
      expect((refreshSpy.mock.calls as unknown[][])[0][2]).toEqual({
        fileChange: true,
        status: "updating styles",
      });
    });

    test("broadcasts app_files_changed for file edit", async () => {
      const ctx = makeCtx();
      const executor = makeFakeExecutor({ content: "{}", isError: false });
      const broadcastSpy = mock(() => {});

      const toolFn = createToolExecutor(
        executor as unknown as ToolExecutor,
        noopPrompter,
        noopSecretPrompter,
        ctx,
        noopLifecycleHandler,
        broadcastSpy,
      );

      await toolFn("app_file_edit", {
        app_id: "app-edit-bc",
        path: "f",
        old_string: "a",
        new_string: "b",
      });

      expect(broadcastSpy).toHaveBeenCalledTimes(1);
      expect((broadcastSpy.mock.calls as unknown[][])[0][0]).toEqual({
        type: "app_files_changed",
        appId: "app-edit-bc",
      });
    });

    test("calls updatePublishedAppDeployment for file edit", async () => {
      const ctx = makeCtx();
      const executor = makeFakeExecutor({ content: "{}", isError: false });

      const toolFn = createToolExecutor(
        executor as unknown as ToolExecutor,
        noopPrompter,
        noopSecretPrompter,
        ctx,
        noopLifecycleHandler,
        mock(() => {}),
      );

      await toolFn("app_file_edit", {
        app_id: "app-pub-edit",
        path: "f",
        old_string: "a",
        new_string: "b",
      });

      expect(updatePublishedSpy).toHaveBeenCalledTimes(1);
      expect((updatePublishedSpy.mock.calls as unknown[][])[0][0]).toBe(
        "app-pub-edit",
      );
    });

    test("surfaces multifile compile failures instead of treating them as success", async () => {
      getAppMock.mockReturnValue({ id: "multi-edit", formatVersion: 2 });
      compileAppMock.mockImplementation(async () => ({
        ok: false,
        errors: [{ text: "Unexpected end of file" }],
        warnings: [],
        durationMs: 18,
        builtAt: Date.now(),
      }));

      const ctx = makeCtx();
      const executor = makeFakeExecutor({ content: "{}", isError: false });
      const broadcastSpy = mock(() => {});

      const toolFn = createToolExecutor(
        executor as unknown as ToolExecutor,
        noopPrompter,
        noopSecretPrompter,
        ctx,
        noopLifecycleHandler,
        broadcastSpy,
      );

      await toolFn("app_file_edit", {
        app_id: "multi-edit",
        path: "src/main.tsx",
        old_string: "old",
        new_string: "new",
      });
      await flushAsyncSideEffects();

      expect(compileAppMock).toHaveBeenCalledTimes(1);
      expect((compileAppMock.mock.calls as unknown[][])[0][0]).toBe(
        "/fake/apps/multi-edit",
      );
      expect(refreshSpy).toHaveBeenCalledTimes(1);
      expect((refreshSpy.mock.calls as unknown[][])[0][2]).toEqual({
        fileChange: true,
        status: "Build failed: Unexpected end of file",
      });
      expect(broadcastSpy).toHaveBeenCalledTimes(1);
      expect(updatePublishedSpy).not.toHaveBeenCalled();
    });

    test("skips side effects when result is an error", async () => {
      const ctx = makeCtx();
      const executor = makeFakeExecutor({ content: "Error", isError: true });
      const broadcastSpy = mock(() => {});

      const toolFn = createToolExecutor(
        executor as unknown as ToolExecutor,
        noopPrompter,
        noopSecretPrompter,
        ctx,
        noopLifecycleHandler,
        broadcastSpy,
      );

      await toolFn("app_file_edit", {
        app_id: "app-err",
        path: "f",
        old_string: "a",
        new_string: "b",
      });

      expect(refreshSpy).not.toHaveBeenCalled();
      expect(broadcastSpy).not.toHaveBeenCalled();
      expect(updatePublishedSpy).not.toHaveBeenCalled();
    });
  });

  // ── app_file_write ──────────────────────────────────────────────────

  describe("app_file_write", () => {
    test("triggers refreshSurfacesForApp with fileChange flag", async () => {
      const ctx = makeCtx();
      const executor = makeFakeExecutor({
        content: '{"written":true}',
        isError: false,
      });
      const broadcastSpy = mock(() => {});

      const toolFn = createToolExecutor(
        executor as unknown as ToolExecutor,
        noopPrompter,
        noopSecretPrompter,
        ctx,
        noopLifecycleHandler,
        broadcastSpy,
      );

      await toolFn("app_file_write", {
        app_id: "app-write",
        path: "new.html",
        content: "<div/>",
      });

      expect(refreshSpy).toHaveBeenCalledTimes(1);
      expect((refreshSpy.mock.calls as unknown[][])[0][1]).toBe("app-write");
      expect((refreshSpy.mock.calls as unknown[][])[0][2]).toEqual({
        fileChange: true,
        status: undefined,
      });
    });

    test("propagates status field through refresh opts", async () => {
      const ctx = makeCtx();
      const executor = makeFakeExecutor({
        content: '{"written":true}',
        isError: false,
      });

      const toolFn = createToolExecutor(
        executor as unknown as ToolExecutor,
        noopPrompter,
        noopSecretPrompter,
        ctx,
        noopLifecycleHandler,
        mock(() => {}),
      );

      await toolFn("app_file_write", {
        app_id: "app-ws",
        path: "f.txt",
        content: "hi",
        status: "adding dark mode",
      });

      expect(refreshSpy).toHaveBeenCalledTimes(1);
      expect((refreshSpy.mock.calls as unknown[][])[0][2]).toEqual({
        fileChange: true,
        status: "adding dark mode",
      });
    });

    test("broadcasts app_files_changed for file write", async () => {
      const ctx = makeCtx();
      const executor = makeFakeExecutor({ content: "{}", isError: false });
      const broadcastSpy = mock(() => {});

      const toolFn = createToolExecutor(
        executor as unknown as ToolExecutor,
        noopPrompter,
        noopSecretPrompter,
        ctx,
        noopLifecycleHandler,
        broadcastSpy,
      );

      await toolFn("app_file_write", {
        app_id: "app-write-bc",
        path: "f",
        content: "x",
      });

      expect(broadcastSpy).toHaveBeenCalledTimes(1);
      expect((broadcastSpy.mock.calls as unknown[][])[0][0]).toEqual({
        type: "app_files_changed",
        appId: "app-write-bc",
      });
    });

    test("calls updatePublishedAppDeployment for file write", async () => {
      const ctx = makeCtx();
      const executor = makeFakeExecutor({ content: "{}", isError: false });

      const toolFn = createToolExecutor(
        executor as unknown as ToolExecutor,
        noopPrompter,
        noopSecretPrompter,
        ctx,
        noopLifecycleHandler,
        mock(() => {}),
      );

      await toolFn("app_file_write", {
        app_id: "app-pub-write",
        path: "f",
        content: "x",
      });

      expect(updatePublishedSpy).toHaveBeenCalledTimes(1);
      expect((updatePublishedSpy.mock.calls as unknown[][])[0][0]).toBe(
        "app-pub-write",
      );
    });

    test("clears prior multifile failure state after a successful rebuild", async () => {
      getAppMock.mockReturnValue({ id: "multi-write", formatVersion: 2 });

      const ctx = makeCtx();
      const executor = makeFakeExecutor({ content: "{}", isError: false });
      const broadcastSpy = mock(() => {});

      const toolFn = createToolExecutor(
        executor as unknown as ToolExecutor,
        noopPrompter,
        noopSecretPrompter,
        ctx,
        noopLifecycleHandler,
        broadcastSpy,
      );

      await toolFn("app_file_write", {
        app_id: "multi-write",
        path: "src/styles.css",
        content: "body { color: green; }",
      });
      await flushAsyncSideEffects();

      expect(refreshSpy).toHaveBeenCalledTimes(1);
      expect((refreshSpy.mock.calls as unknown[][])[0][2]).toEqual({
        fileChange: true,
        status: null,
      });
      expect(broadcastSpy).toHaveBeenCalledTimes(1);
      expect(updatePublishedSpy).toHaveBeenCalledTimes(1);
      expect((updatePublishedSpy.mock.calls as unknown[][])[0][0]).toBe(
        "multi-write",
      );
    });

    test("skips side effects when result is an error", async () => {
      const ctx = makeCtx();
      const executor = makeFakeExecutor({ content: "Error", isError: true });
      const broadcastSpy = mock(() => {});

      const toolFn = createToolExecutor(
        executor as unknown as ToolExecutor,
        noopPrompter,
        noopSecretPrompter,
        ctx,
        noopLifecycleHandler,
        broadcastSpy,
      );

      await toolFn("app_file_write", {
        app_id: "app-err",
        path: "f",
        content: "x",
      });

      expect(refreshSpy).not.toHaveBeenCalled();
      expect(broadcastSpy).not.toHaveBeenCalled();
      expect(updatePublishedSpy).not.toHaveBeenCalled();
    });
  });

  // ── app_create side effects ─────────────────────────────────────────

  describe("app_create side effects", () => {
    test("broadcasts app_files_changed immediately after app_create", async () => {
      const ctx = makeCtx();
      const executor = makeFakeExecutor({
        content: JSON.stringify({ id: "new-app-1", name: "My App" }),
        isError: false,
      });
      const broadcastSpy = mock(() => {});

      const toolFn = createToolExecutor(
        executor as unknown as ToolExecutor,
        noopPrompter,
        noopSecretPrompter,
        ctx,
        noopLifecycleHandler,
        broadcastSpy,
      );

      await toolFn("app_create", { name: "My App", html: "<h1>hi</h1>" });

      expect(broadcastSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
      expect((broadcastSpy.mock.calls as unknown[][])[0][0]).toEqual({
        type: "app_files_changed",
        appId: "new-app-1",
      });
    });

    test("skips side effects when app_create result is an error", async () => {
      const ctx = makeCtx();
      const executor = makeFakeExecutor({ content: "Error", isError: true });
      const broadcastSpy = mock(() => {});

      const toolFn = createToolExecutor(
        executor as unknown as ToolExecutor,
        noopPrompter,
        noopSecretPrompter,
        ctx,
        noopLifecycleHandler,
        broadcastSpy,
      );

      await toolFn("app_create", { name: "Bad", html: "" });

      expect(broadcastSpy).not.toHaveBeenCalled();
    });
  });

  // ── app_delete side effects ────────────────────────────────────────

  describe("app_delete side effects", () => {
    test("broadcasts app_files_changed after app_delete", async () => {
      const ctx = makeCtx();
      const executor = makeFakeExecutor({ content: "{}", isError: false });
      const broadcastSpy = mock(() => {});

      const toolFn = createToolExecutor(
        executor as unknown as ToolExecutor,
        noopPrompter,
        noopSecretPrompter,
        ctx,
        noopLifecycleHandler,
        broadcastSpy,
      );

      await toolFn("app_delete", { app_id: "del-app-1" });

      expect(broadcastSpy).toHaveBeenCalledTimes(1);
      expect((broadcastSpy.mock.calls as unknown[][])[0][0]).toEqual({
        type: "app_files_changed",
        appId: "del-app-1",
      });
    });

    test("skips side effects when app_delete result is an error", async () => {
      const ctx = makeCtx();
      const executor = makeFakeExecutor({ content: "Error", isError: true });
      const broadcastSpy = mock(() => {});

      const toolFn = createToolExecutor(
        executor as unknown as ToolExecutor,
        noopPrompter,
        noopSecretPrompter,
        ctx,
        noopLifecycleHandler,
        broadcastSpy,
      );

      await toolFn("app_delete", { app_id: "del-err" });

      expect(broadcastSpy).not.toHaveBeenCalled();
    });
  });

  // ── Name-based hook targeting (skill-origin tools) ──────────────────

  describe("name-based hooks fire for skill-origin tools", () => {
    test("hooks fire purely on tool name, regardless of tool origin", async () => {
      // The key invariant: createToolExecutor uses `name === 'app_update'`
      // string comparison, not tool metadata or origin. This means skill-
      // projected tools with the same name trigger the same afterExecute
      // hooks as core tools.
      const ctx = makeCtx();
      const executor = makeFakeExecutor({ content: "{}", isError: false });
      const broadcastSpy = mock(() => {});

      const toolFn = createToolExecutor(
        executor as unknown as ToolExecutor,
        noopPrompter,
        noopSecretPrompter,
        ctx,
        noopLifecycleHandler,
        broadcastSpy,
      );

      // Simulate calling each app tool by name (as the agent loop does)
      for (const toolName of [
        "app_update",
        "app_file_edit",
        "app_file_write",
      ]) {
        refreshSpy.mockClear();
        broadcastSpy.mockClear();
        updatePublishedSpy.mockClear();

        await toolFn(toolName, {
          app_id: "skill-app",
          path: "f",
          old_string: "a",
          new_string: "b",
          content: "x",
        });

        expect(refreshSpy).toHaveBeenCalledTimes(1);
        expect(broadcastSpy).toHaveBeenCalledTimes(1);
        expect(updatePublishedSpy).toHaveBeenCalledTimes(1);
      }
    });
  });

  // ── Non-app tools do not trigger hooks ──────────────────────────────

  describe("non-app tools", () => {
    test("other tool names do not trigger app refresh side effects", async () => {
      const ctx = makeCtx();
      const executor = makeFakeExecutor({ content: "{}", isError: false });
      const broadcastSpy = mock(() => {});

      const toolFn = createToolExecutor(
        executor as unknown as ToolExecutor,
        noopPrompter,
        noopSecretPrompter,
        ctx,
        noopLifecycleHandler,
        broadcastSpy,
      );

      for (const toolName of ["read_file", "write_file", "shell", "app_list"]) {
        refreshSpy.mockClear();
        broadcastSpy.mockClear();
        updatePublishedSpy.mockClear();

        await toolFn(toolName, { app_id: "app-1" });

        expect(refreshSpy).not.toHaveBeenCalled();
        expect(broadcastSpy).not.toHaveBeenCalled();
        expect(updatePublishedSpy).not.toHaveBeenCalled();
      }
    });
  });

  // ── broadcastToAllClients optional ──────────────────────────────────

  describe("broadcastToAllClients is optional", () => {
    test("side effects work without broadcastToAllClients callback", async () => {
      const ctx = makeCtx();
      const executor = makeFakeExecutor({ content: "{}", isError: false });

      // No broadcast callback provided
      const toolFn = createToolExecutor(
        executor as unknown as ToolExecutor,
        noopPrompter,
        noopSecretPrompter,
        ctx,
        noopLifecycleHandler,
      );

      // Should not throw even though broadcastToAllClients is undefined
      const result = await toolFn("app_update", { app_id: "app-no-bc" });

      expect(result.isError).toBe(false);
      expect(refreshSpy).toHaveBeenCalledTimes(1);
      expect(updatePublishedSpy).toHaveBeenCalledTimes(1);
    });
  });
});
