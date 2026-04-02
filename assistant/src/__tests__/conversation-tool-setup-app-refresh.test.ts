/**
 * Regression tests for app surface refresh and eventing side effects in
 * createToolExecutor (conversation-tool-setup.ts).
 *
 * Tests verify that app_refresh, app_create, and app_delete hooks fire
 * correctly, and that removed hooks (app_update, app_file_edit,
 * app_file_write) no longer trigger side effects.
 *
 * File-change detection for file_write/file_edit is handled by
 * AppSourceWatcher (see app-source-watcher.test.ts).
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

// Mock browser-screencast registration (no-op)
mock.module("../tools/browser/browser-screencast.js", () => ({
  registerConversationSender: mock(() => {}),
}));

// Mock app-store functions used by handleAppChange in tool-side-effects
mock.module("../memory/app-store.js", () => ({
  getApp: mock(() => null),
  getAppDirPath: mock(() => "/tmp/test-apps/dummy"),
  isMultifileApp: mock(() => false),
  getAppsDir: mock(() => "/tmp/test-apps"),
  resolveAppIdByDirName: mock(() => null),
  resolveAppIdFromPath: mock(() => null),
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
    accumulatedSurfaceState: new Map(),
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("session-tool-setup app refresh side effects", () => {
  beforeEach(() => {
    refreshSpy.mockClear();
    updatePublishedSpy.mockClear();
  });

  // ── app_refresh ─────────────────────────────────────────────────────

  describe("app_refresh", () => {
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

      await toolFn("app_refresh", { app_id: "app-1" });

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

      await toolFn("app_refresh", { app_id: "app-42" });

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

      await toolFn("app_refresh", { app_id: "app-publish" });

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

      await toolFn("app_refresh", { app_id: "app-err" });

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

      await toolFn("app_refresh", {});

      expect(refreshSpy).not.toHaveBeenCalled();
      expect(broadcastSpy).not.toHaveBeenCalled();
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
      // The key invariant: createToolExecutor uses `name === 'app_refresh'`
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

      // Simulate calling app_refresh by name (as the agent loop does)
      for (const toolName of ["app_refresh"]) {
        refreshSpy.mockClear();
        broadcastSpy.mockClear();
        updatePublishedSpy.mockClear();

        await toolFn(toolName, {
          app_id: "skill-app",
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

      for (const toolName of [
        "read_file",
        "write_file",
        "shell",
        "app_list",
        "app_update",
        "app_file_edit",
        "app_file_write",
      ]) {
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
      const result = await toolFn("app_refresh", { app_id: "app-no-bc" });

      expect(result.isError).toBe(false);
      expect(refreshSpy).toHaveBeenCalledTimes(1);
      expect(updatePublishedSpy).toHaveBeenCalledTimes(1);
    });
  });

});
