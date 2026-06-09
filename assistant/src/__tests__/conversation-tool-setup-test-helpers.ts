/**
 * Shared scaffolding for conversation-tool-setup (createToolExecutor) tests.
 *
 * `installConversationToolSetupMocks()` mocks the side-effect modules that
 * conversation-tool-setup.ts pulls in at import time. `mock.module` is
 * process-global and order-sensitive: call it BEFORE the import statement for
 * `../daemon/conversation-tool-setup.js`, mirroring how the test files
 * sequence statements and imports.
 *
 * Test-machinery isolation (assistant/AGENTS.md): this helper's only runtime
 * import is `bun:test`, and the mock factories return plain stub objects.
 * Production types are referenced via `import type` only — a value import
 * would pull those modules' import-time side effects into this helper.
 */

import { mock } from "bun:test";

import type { ToolSetupContext } from "../daemon/conversation-tool-setup.js";
import type { SurfaceData, SurfaceType } from "../daemon/message-protocol.js";

/**
 * Spies installed by {@link installConversationToolSetupMocks}. Shared across
 * test files in the same process — clear them in `beforeEach` when asserting
 * on call counts.
 */
export const refreshSurfacesForAppSpy = mock(() => {});
export const broadcastMessageSpy = mock(() => {});
export const updatePublishedAppDeploymentSpy = mock(() => Promise.resolve());

/**
 * Mock the modules whose import-time / call-time side effects must not run
 * during conversation-tool-setup tests.
 */
export function installConversationToolSetupMocks(): void {
  mock.module("../runtime/assistant-event-hub.js", () => ({
    broadcastMessage: broadcastMessageSpy,
  }));

  // Mock conversation-surfaces so refreshSurfacesForApp is captured.
  mock.module("../daemon/conversation-surfaces.js", () => ({
    refreshSurfacesForApp: refreshSurfacesForAppSpy,
    surfaceProxyResolver: mock(() =>
      Promise.resolve({ content: "", isError: false }),
    ),
  }));

  // Mock published-app-updater to prevent real deployment calls.
  mock.module("../services/published-app-updater.js", () => ({
    updatePublishedAppDeployment: updatePublishedAppDeploymentSpy,
  }));

  // Mock browser-screencast registration (no-op).
  mock.module("../tools/browser/browser-screencast.js", () => ({
    registerConversationSender: mock(() => {}),
  }));

  // Stub app-store functions used by other modules (e.g. app-source-watcher,
  // conversation-surfaces) so tool-side-effects' hooks can run without
  // touching the real app store during tests.
  mock.module("../memory/app-store.js", () => ({
    getApp: mock(() => null),
    getAppDirPath: mock(() => "/tmp/test-apps/dummy"),
    isMultifileApp: mock(() => false),
    getAppsDir: mock(() => "/tmp/test-apps"),
    resolveAppIdByDirName: mock(() => null),
    resolveAppIdFromPath: mock(() => null),
  }));
}

/** Build a minimal ToolSetupContext stub. */
export function makeToolSetupContext(
  overrides: Partial<ToolSetupContext> = {},
): ToolSetupContext {
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
    ...overrides,
  };
}
