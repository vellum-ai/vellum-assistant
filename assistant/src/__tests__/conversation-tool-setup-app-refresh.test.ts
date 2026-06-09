/**
 * Regression tests for app surface refresh and eventing side effects in
 * createToolExecutor (conversation-tool-setup.ts).
 *
 * Tests verify that app_refresh, app_update, app_create, and app_delete hooks
 * fire correctly, and that non-hooked tools (app_file_edit, app_file_write) do
 * not trigger side effects.
 *
 * File-change detection for file_write/file_edit is handled by
 * AppSourceWatcher (see app-source-watcher.test.ts).
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import { SYNC_TAGS } from "../daemon/message-types/sync.js";
import type { PermissionPrompter } from "../permissions/prompter.js";
import type { SecretPrompter } from "../permissions/secret-prompter.js";
import type { ToolExecutor } from "../tools/executor.js";
import type { ToolExecutionResult } from "../tools/types.js";
import {
  broadcastMessageSpy,
  installConversationToolSetupMocks,
  makeToolSetupContext,
  refreshSurfacesForAppSpy,
  updatePublishedAppDeploymentSpy,
} from "./conversation-tool-setup-test-helpers.js";

installConversationToolSetupMocks();

// ---------------------------------------------------------------------------
// Import createToolExecutor after mocks are in place
// ---------------------------------------------------------------------------

import { createToolExecutor } from "../daemon/conversation-tool-setup.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function broadcastPayloads(): unknown[] {
  return (broadcastMessageSpy.mock.calls as unknown[][]).map(
    ([payload]) => payload,
  );
}

function expectAppChangeBroadcast(appId: string): void {
  expect(broadcastPayloads()).toEqual(
    expect.arrayContaining([
      { type: "app_files_changed", appId },
      { type: "sync_changed", tags: [SYNC_TAGS.appsList] },
    ]) as never,
  );
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
    refreshSurfacesForAppSpy.mockClear();
    broadcastMessageSpy.mockClear();
    updatePublishedAppDeploymentSpy.mockClear();
  });

  // ── app_refresh ─────────────────────────────────────────────────────

  describe("app_refresh", () => {
    test("triggers refreshSurfacesForApp when result is not an error", async () => {
      const ctx = makeToolSetupContext();
      const executor = makeFakeExecutor({
        content: '{"id":"app-1"}',
        isError: false,
      });

      const toolFn = createToolExecutor(
        executor as unknown as ToolExecutor,
        noopPrompter,
        noopSecretPrompter,
        ctx,
        noopLifecycleHandler,
      );

      await toolFn("app_refresh", { app_id: "app-1" });

      expect(refreshSurfacesForAppSpy).toHaveBeenCalledTimes(1);
      expect((refreshSurfacesForAppSpy.mock.calls as unknown[][])[0][0]).toBe(
        ctx,
      );
      expect((refreshSurfacesForAppSpy.mock.calls as unknown[][])[0][1]).toBe(
        "app-1",
      );
    });

    test("broadcasts app_files_changed with correct appId", async () => {
      const ctx = makeToolSetupContext();
      const executor = makeFakeExecutor({ content: "{}", isError: false });

      const toolFn = createToolExecutor(
        executor as unknown as ToolExecutor,
        noopPrompter,
        noopSecretPrompter,
        ctx,
        noopLifecycleHandler,
      );

      await toolFn("app_refresh", { app_id: "app-42" });

      expect(broadcastMessageSpy).toHaveBeenCalledTimes(2);
      expectAppChangeBroadcast("app-42");
    });

    test("calls updatePublishedAppDeployment", async () => {
      const ctx = makeToolSetupContext();
      const executor = makeFakeExecutor({ content: "{}", isError: false });

      const toolFn = createToolExecutor(
        executor as unknown as ToolExecutor,
        noopPrompter,
        noopSecretPrompter,
        ctx,
        noopLifecycleHandler,
      );

      await toolFn("app_refresh", { app_id: "app-publish" });

      // updatePublishedAppDeployment is called with void (fire-and-forget),
      // so just verify it was invoked.
      expect(updatePublishedAppDeploymentSpy).toHaveBeenCalledTimes(1);
      expect(
        (updatePublishedAppDeploymentSpy.mock.calls as unknown[][])[0][0],
      ).toBe("app-publish");
    });

    test("skips side effects when result is an error", async () => {
      const ctx = makeToolSetupContext();
      const executor = makeFakeExecutor({
        content: "Error: not found",
        isError: true,
      });

      const toolFn = createToolExecutor(
        executor as unknown as ToolExecutor,
        noopPrompter,
        noopSecretPrompter,
        ctx,
        noopLifecycleHandler,
      );

      await toolFn("app_refresh", { app_id: "app-err" });

      expect(refreshSurfacesForAppSpy).not.toHaveBeenCalled();
      expect(broadcastMessageSpy).not.toHaveBeenCalled();
      expect(updatePublishedAppDeploymentSpy).not.toHaveBeenCalled();
    });

    test("skips side effects when app_id is missing", async () => {
      const ctx = makeToolSetupContext();
      const executor = makeFakeExecutor({ content: "{}", isError: false });

      const toolFn = createToolExecutor(
        executor as unknown as ToolExecutor,
        noopPrompter,
        noopSecretPrompter,
        ctx,
        noopLifecycleHandler,
      );

      await toolFn("app_refresh", {});

      expect(refreshSurfacesForAppSpy).not.toHaveBeenCalled();
      expect(broadcastMessageSpy).not.toHaveBeenCalled();
    });
  });

  // ── app_update ──────────────────────────────────────────────────────

  describe("app_update", () => {
    test("triggers refreshSurfacesForApp and broadcast on success", async () => {
      const ctx = makeToolSetupContext();
      const executor = makeFakeExecutor({
        content: '{"updated":true,"appId":"app-7"}',
        isError: false,
      });

      const toolFn = createToolExecutor(
        executor as unknown as ToolExecutor,
        noopPrompter,
        noopSecretPrompter,
        ctx,
        noopLifecycleHandler,
      );

      await toolFn("app_update", { app_id: "app-7" });

      expect(refreshSurfacesForAppSpy).toHaveBeenCalledTimes(1);
      expect((refreshSurfacesForAppSpy.mock.calls as unknown[][])[0][1]).toBe(
        "app-7",
      );
      expectAppChangeBroadcast("app-7");
      expect(updatePublishedAppDeploymentSpy).toHaveBeenCalledTimes(1);
      expect(
        (updatePublishedAppDeploymentSpy.mock.calls as unknown[][])[0][0],
      ).toBe("app-7");
    });

    test("skips side effects when result is an error", async () => {
      const ctx = makeToolSetupContext();
      const executor = makeFakeExecutor({
        content: "Error: not found",
        isError: true,
      });

      const toolFn = createToolExecutor(
        executor as unknown as ToolExecutor,
        noopPrompter,
        noopSecretPrompter,
        ctx,
        noopLifecycleHandler,
      );

      await toolFn("app_update", { app_id: "app-err" });

      expect(refreshSurfacesForAppSpy).not.toHaveBeenCalled();
      expect(broadcastMessageSpy).not.toHaveBeenCalled();
      expect(updatePublishedAppDeploymentSpy).not.toHaveBeenCalled();
    });

    test("skips side effects when app_id is missing", async () => {
      const ctx = makeToolSetupContext();
      const executor = makeFakeExecutor({ content: "{}", isError: false });

      const toolFn = createToolExecutor(
        executor as unknown as ToolExecutor,
        noopPrompter,
        noopSecretPrompter,
        ctx,
        noopLifecycleHandler,
      );

      await toolFn("app_update", {});

      expect(refreshSurfacesForAppSpy).not.toHaveBeenCalled();
      expect(broadcastMessageSpy).not.toHaveBeenCalled();
    });
  });

  // ── app_create side effects ─────────────────────────────────────────

  describe("app_create side effects", () => {
    test("broadcasts app_files_changed immediately after app_create", async () => {
      const ctx = makeToolSetupContext();
      const executor = makeFakeExecutor({
        content: JSON.stringify({ id: "new-app-1", name: "My App" }),
        isError: false,
      });

      const toolFn = createToolExecutor(
        executor as unknown as ToolExecutor,
        noopPrompter,
        noopSecretPrompter,
        ctx,
        noopLifecycleHandler,
      );

      await toolFn("app_create", { name: "My App", html: "<h1>hi</h1>" });

      expect(broadcastMessageSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
      expect((broadcastMessageSpy.mock.calls as unknown[][])[0][0]).toEqual({
        type: "app_files_changed",
        appId: "new-app-1",
      });
      expectAppChangeBroadcast("new-app-1");
    });

    test("canonicalizes create_app skill_execute alias before hooks run", async () => {
      const ctx = makeToolSetupContext({
        allowedToolNames: new Set(["app_create"]),
      });
      const executor = makeFakeExecutor({
        content: JSON.stringify({ id: "alias-app-1", name: "Alias App" }),
        isError: false,
      });

      const toolFn = createToolExecutor(
        executor as unknown as ToolExecutor,
        noopPrompter,
        noopSecretPrompter,
        ctx,
        noopLifecycleHandler,
      );

      await toolFn("skill_execute", {
        tool: "create_app",
        input: { name: "Alias App" },
        activity: "Building app",
      });

      const calls = executor.execute.mock.calls as unknown[][];
      expect(calls[0][0]).toBe("app_create");
      expect(calls[0][1]).toEqual({ name: "Alias App" });
      expect(broadcastMessageSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
      expect((broadcastMessageSpy.mock.calls as unknown[][])[0][0]).toEqual({
        type: "app_files_changed",
        appId: "alias-app-1",
      });
      expectAppChangeBroadcast("alias-app-1");
    });

    test("canonicalizes legacy computer_use_press_key skill_execute alias before dispatch", async () => {
      const ctx = makeToolSetupContext({
        allowedToolNames: new Set(["computer_use_key"]),
      });
      const executor = makeFakeExecutor({ content: "ok", isError: false });

      const toolFn = createToolExecutor(
        executor as unknown as ToolExecutor,
        noopPrompter,
        noopSecretPrompter,
        ctx,
        noopLifecycleHandler,
      );

      await toolFn("skill_execute", {
        tool: "computer_use_press_key",
        input: {
          key: "Space",
          modifiers: ["Command"],
          reasoning: "Open Spotlight",
        },
        activity: "Opening Spotlight",
      });

      const calls = executor.execute.mock.calls as unknown[][];
      expect(calls[0][0]).toBe("computer_use_key");
      expect(calls[0][1]).toEqual({
        key: "cmd+space",
        reasoning: "Open Spotlight",
      });
    });

    test("preserves exact active create_app skill tool when app_create is also active", async () => {
      const ctx = makeToolSetupContext({
        allowedToolNames: new Set(["create_app", "app_create"]),
      });
      const executor = makeFakeExecutor({
        content: JSON.stringify({ id: "custom-app-1", name: "Custom App" }),
        isError: false,
      });

      const toolFn = createToolExecutor(
        executor as unknown as ToolExecutor,
        noopPrompter,
        noopSecretPrompter,
        ctx,
        noopLifecycleHandler,
      );

      await toolFn("skill_execute", {
        tool: "create_app",
        input: { name: "Custom App" },
        activity: "Running custom app tool",
      });

      const calls = executor.execute.mock.calls as unknown[][];
      expect(calls[0][0]).toBe("create_app");
      expect(broadcastMessageSpy).not.toHaveBeenCalled();
    });

    test("skips side effects when app_create result is an error", async () => {
      const ctx = makeToolSetupContext();
      const executor = makeFakeExecutor({ content: "Error", isError: true });

      const toolFn = createToolExecutor(
        executor as unknown as ToolExecutor,
        noopPrompter,
        noopSecretPrompter,
        ctx,
        noopLifecycleHandler,
      );

      await toolFn("app_create", { name: "Bad", html: "" });

      expect(broadcastMessageSpy).not.toHaveBeenCalled();
    });

    test("fires notify side effects regardless of compile outcome reported in payload", async () => {
      // The hook observes the tool result but does not branch on compile
      // status fields inside it. Whether the executor reports a successful
      // compile or returns compile_errors, the hook still refreshes
      // surfaces and broadcasts — compile retries are the LLM's
      // responsibility via a follow-up tool call, not the hook's.
      const ctx = makeToolSetupContext();
      const executor = makeFakeExecutor({
        content: JSON.stringify({
          id: "new-app-err",
          name: "Busted",
          compiled: false,
          compile_errors: [{ text: "syntax error" }],
        }),
        isError: false,
      });

      const toolFn = createToolExecutor(
        executor as unknown as ToolExecutor,
        noopPrompter,
        noopSecretPrompter,
        ctx,
        noopLifecycleHandler,
      );

      await toolFn("app_create", { name: "Busted", html: "" });

      expect(refreshSurfacesForAppSpy).toHaveBeenCalledTimes(1);
      expect(broadcastMessageSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
      expect((broadcastMessageSpy.mock.calls as unknown[][])[0][0]).toEqual({
        type: "app_files_changed",
        appId: "new-app-err",
      });
      expectAppChangeBroadcast("new-app-err");
      expect(updatePublishedAppDeploymentSpy).toHaveBeenCalledTimes(1);
    });
  });

  // ── app_delete side effects ────────────────────────────────────────

  describe("app_delete side effects", () => {
    test("broadcasts app_files_changed after app_delete", async () => {
      const ctx = makeToolSetupContext();
      const executor = makeFakeExecutor({ content: "{}", isError: false });

      const toolFn = createToolExecutor(
        executor as unknown as ToolExecutor,
        noopPrompter,
        noopSecretPrompter,
        ctx,
        noopLifecycleHandler,
      );

      await toolFn("app_delete", { app_id: "del-app-1" });

      expect(broadcastMessageSpy).toHaveBeenCalledTimes(2);
      expectAppChangeBroadcast("del-app-1");
    });

    test("skips side effects when app_delete result is an error", async () => {
      const ctx = makeToolSetupContext();
      const executor = makeFakeExecutor({ content: "Error", isError: true });

      const toolFn = createToolExecutor(
        executor as unknown as ToolExecutor,
        noopPrompter,
        noopSecretPrompter,
        ctx,
        noopLifecycleHandler,
      );

      await toolFn("app_delete", { app_id: "del-err" });

      expect(broadcastMessageSpy).not.toHaveBeenCalled();
    });
  });

  // ── Name-based hook targeting (skill-origin tools) ──────────────────

  describe("name-based hooks fire for skill-origin tools", () => {
    test("hooks fire purely on tool name, regardless of tool origin", async () => {
      // The key invariant: createToolExecutor uses `name === 'app_refresh'`
      // string comparison, not tool metadata or origin. This means skill-
      // projected tools with the same name trigger the same afterExecute
      // hooks as core tools.
      const ctx = makeToolSetupContext();
      const executor = makeFakeExecutor({ content: "{}", isError: false });

      const toolFn = createToolExecutor(
        executor as unknown as ToolExecutor,
        noopPrompter,
        noopSecretPrompter,
        ctx,
        noopLifecycleHandler,
      );

      // Simulate calling app_refresh by name (as the agent loop does)
      for (const toolName of ["app_refresh"]) {
        refreshSurfacesForAppSpy.mockClear();
        broadcastMessageSpy.mockClear();
        broadcastMessageSpy.mockClear();
        updatePublishedAppDeploymentSpy.mockClear();

        await toolFn(toolName, {
          app_id: "skill-app",
        });

        expect(refreshSurfacesForAppSpy).toHaveBeenCalledTimes(1);
        expect(broadcastMessageSpy).toHaveBeenCalledTimes(2);
        expectAppChangeBroadcast("skill-app");
        expect(updatePublishedAppDeploymentSpy).toHaveBeenCalledTimes(1);
      }
    });
  });

  // ── Non-app tools do not trigger hooks ──────────────────────────────

  describe("non-app tools", () => {
    test("other tool names do not trigger app refresh side effects", async () => {
      const ctx = makeToolSetupContext();
      const executor = makeFakeExecutor({ content: "{}", isError: false });

      const toolFn = createToolExecutor(
        executor as unknown as ToolExecutor,
        noopPrompter,
        noopSecretPrompter,
        ctx,
        noopLifecycleHandler,
      );

      for (const toolName of [
        "read_file",
        "write_file",
        "shell",
        "app_list",
        "app_file_edit",
        "app_file_write",
      ]) {
        refreshSurfacesForAppSpy.mockClear();
        broadcastMessageSpy.mockClear();
        broadcastMessageSpy.mockClear();
        updatePublishedAppDeploymentSpy.mockClear();

        await toolFn(toolName, { app_id: "app-1" });

        expect(refreshSurfacesForAppSpy).not.toHaveBeenCalled();
        expect(broadcastMessageSpy).not.toHaveBeenCalled();
        expect(updatePublishedAppDeploymentSpy).not.toHaveBeenCalled();
      }
    });
  });
});
