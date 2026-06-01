import { beforeEach, describe, expect, mock, test } from "bun:test";

import type {
  ActiveConversationMessagesRefreshResult,
  WebSyncRouter,
} from "@/lib/sync/web-sync-router";

const recordDiagnosticMock = mock(() => {});
const bucketMessagesAddedMock = mock(() => "0");
const resolvePlatformTagMock = mock(() => "web");
mock.module("@/lib/diagnostics", () => ({
  recordDiagnostic: recordDiagnosticMock,
  bucketMessagesAdded: bucketMessagesAddedMock,
  resolvePlatformTag: resolvePlatformTagMock,
}));

const addBreadcrumbMock = mock(() => {});
const captureMessageMock = mock(() => {});
const captureExceptionMock = mock(() => {});
mock.module("@sentry/react", () => ({
  addBreadcrumb: addBreadcrumbMock,
  captureMessage: captureMessageMock,
  captureException: captureExceptionMock,
}));

const { createReconcileOnReopen } = await import(
  "@/domains/chat/streaming/reconcile-on-reopen"
);

const makeReconcileResult = (
  override: Partial<ActiveConversationMessagesRefreshResult> = {},
): ActiveConversationMessagesRefreshResult => ({
  changed: false,
  messagesAdded: 0,
  assistantProgress: false,
  ...override,
});

const makeDeps = (override: Partial<{
  assistantId: string;
  conversationId: string;
  streamEpochRef: { current: number };
  reconcileActive: () => Promise<ActiveConversationMessagesRefreshResult>;
  startReconciliationLoop: (epoch: number) => void;
  syncRouterRef: { current: WebSyncRouter | null };
}> = {}) => {
  const streamEpochRef = override.streamEpochRef ?? { current: 0 };
  const reconcileActive = override.reconcileActive ?? mock(async () => makeReconcileResult());
  const startReconciliationLoop = override.startReconciliationLoop ?? mock(() => {});
  const syncRouterRef = override.syncRouterRef ?? { current: null };
  return {
    streamEpochRef,
    reconcileActive,
    startReconciliationLoop,
    syncRouterRef,
    deps: {
      assistantId: override.assistantId ?? "asst-1",
      conversationId: override.conversationId ?? "conv-1",
      streamEpochRef,
      reconcileActive,
      startReconciliationLoop,
      syncRouterRef,
    },
  };
};

beforeEach(() => {
  recordDiagnosticMock.mockClear();
  addBreadcrumbMock.mockClear();
  captureMessageMock.mockClear();
  captureExceptionMock.mockClear();
});

describe("reconcile-on-reopen — gating", () => {
  test("ignores opens for a different assistant", () => {
    const { deps, streamEpochRef, reconcileActive, startReconciliationLoop } =
      makeDeps();
    const handler = createReconcileOnReopen(deps);

    handler.handleSseOpened({ assistantId: "asst-OTHER", cause: "resume" });

    expect(streamEpochRef.current).toBe(0);
    expect(reconcileActive).not.toHaveBeenCalled();
    expect(startReconciliationLoop).not.toHaveBeenCalled();
  });

  test("fresh cause: bumps epoch but does not reconcile", () => {
    const { deps, streamEpochRef, reconcileActive, startReconciliationLoop } =
      makeDeps();
    const handler = createReconcileOnReopen(deps);

    handler.handleSseOpened({ assistantId: "asst-1", cause: "fresh" });

    expect(streamEpochRef.current).toBe(1);
    expect(reconcileActive).not.toHaveBeenCalled();
    expect(startReconciliationLoop).not.toHaveBeenCalled();
  });
});

describe("reconcile-on-reopen — resume cause", () => {
  test("standalone reconcile + start the loop on the bumped epoch", () => {
    const { deps, streamEpochRef, reconcileActive, startReconciliationLoop } =
      makeDeps();
    const handler = createReconcileOnReopen(deps);

    handler.handleSseOpened({ assistantId: "asst-1", cause: "resume" });

    expect(streamEpochRef.current).toBe(1);
    expect(reconcileActive).toHaveBeenCalledTimes(1);
    expect(startReconciliationLoop).toHaveBeenCalledWith(1);
  });
});

describe("reconcile-on-reopen — transport recovery (watchdog / error)", () => {
  test("watchdog with sync router available: uses sync router result, no fallback reconcile", async () => {
    const dispatchReconnect = mock(async () => ({
      activeConversationMessages: makeReconcileResult({ messagesAdded: 3 }),
    }));
    const { deps, reconcileActive, startReconciliationLoop } = makeDeps({
      syncRouterRef: { current: { dispatchReconnect } as unknown as WebSyncRouter },
    });
    const handler = createReconcileOnReopen(deps);

    handler.handleSseOpened({ assistantId: "asst-1", cause: "watchdog" });
    await new Promise((r) => setTimeout(r, 0));

    expect(dispatchReconnect).toHaveBeenCalledTimes(1);
    expect(reconcileActive).not.toHaveBeenCalled();
    expect(startReconciliationLoop).toHaveBeenCalledWith(1);
  });

  test("error with no sync router: falls back to standalone reconcile", async () => {
    const { deps, reconcileActive, startReconciliationLoop } = makeDeps();
    const handler = createReconcileOnReopen(deps);

    handler.handleSseOpened({ assistantId: "asst-1", cause: "error" });
    await new Promise((r) => setTimeout(r, 0));

    expect(reconcileActive).toHaveBeenCalledTimes(1);
    expect(startReconciliationLoop).toHaveBeenCalledWith(1);
  });

  test("stale epoch: if a later open bumps the epoch mid-reconcile, this completion self-cancels", async () => {
    let resolveReconcile: (r: ActiveConversationMessagesRefreshResult) => void =
      () => {};
    const reconcileActive = mock(
      () =>
        new Promise<ActiveConversationMessagesRefreshResult>((resolve) => {
          resolveReconcile = resolve;
        }),
    );
    const { deps, streamEpochRef, startReconciliationLoop } = makeDeps({
      reconcileActive,
    });
    const handler = createReconcileOnReopen(deps);

    handler.handleSseOpened({ assistantId: "asst-1", cause: "watchdog" });
    expect(streamEpochRef.current).toBe(1);

    // Simulate a racing later reopen: bump the epoch before the
    // in-flight reconcile resolves.
    streamEpochRef.current = 2;
    resolveReconcile(makeReconcileResult({ messagesAdded: 5 }));
    await new Promise((r) => setTimeout(r, 0));

    // Stale completion must NOT call startReconciliationLoop.
    expect(startReconciliationLoop).not.toHaveBeenCalled();
    expect(captureMessageMock).not.toHaveBeenCalled();
  });

  test("watchdog success records the rescue outcome to Sentry", async () => {
    const reconcileActive = mock(
      async () => makeReconcileResult({ messagesAdded: 2, changed: true }),
    );
    const { deps } = makeDeps({ reconcileActive });
    const handler = createReconcileOnReopen(deps);

    handler.handleSseOpened({ assistantId: "asst-1", cause: "watchdog" });
    await new Promise((r) => setTimeout(r, 0));

    expect(addBreadcrumbMock).toHaveBeenCalled();
    expect(captureMessageMock).toHaveBeenCalledWith(
      "sse_post_watchdog_reconcile_result",
      expect.objectContaining({
        level: "info",
        tags: expect.objectContaining({
          context: "sse_watchdog",
          rescued: "true",
        }),
      }),
    );
  });

  test("error cause does NOT record the watchdog rescue diagnostics", async () => {
    const reconcileActive = mock(
      async () => makeReconcileResult({ messagesAdded: 1 }),
    );
    const { deps } = makeDeps({ reconcileActive });
    const handler = createReconcileOnReopen(deps);

    handler.handleSseOpened({ assistantId: "asst-1", cause: "error" });
    await new Promise((r) => setTimeout(r, 0));

    expect(addBreadcrumbMock).not.toHaveBeenCalled();
    expect(captureMessageMock).not.toHaveBeenCalled();
  });

  test("standalone reconcile rejection: logs to Sentry, does not run the loop, does not propagate", async () => {
    // No sync router, so the code falls back to `reconcileActive()`.
    // That fallback rejects; the handler must log + bail without
    // touching `startReconciliationLoop` or surfacing an unhandled
    // promise rejection.
    const reconcileActive = mock(async () => {
      throw new Error("daemon unreachable");
    });
    const { deps, startReconciliationLoop } = makeDeps({ reconcileActive });
    const handler = createReconcileOnReopen(deps);

    handler.handleSseOpened({ assistantId: "asst-1", cause: "watchdog" });
    await new Promise((r) => setTimeout(r, 0));

    expect(reconcileActive).toHaveBeenCalledTimes(1);
    expect(startReconciliationLoop).not.toHaveBeenCalled();
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    expect(captureMessageMock).not.toHaveBeenCalled();
  });

  test("sync-router dispatchReconnect rejection: logs to Sentry, does not fall back to reconcileActive, does not run the loop", async () => {
    const dispatchReconnect = mock(async () => {
      throw new Error("sync router transport failed");
    });
    const reconcileActive = mock(async () => makeReconcileResult());
    const { deps, startReconciliationLoop } = makeDeps({
      reconcileActive,
      syncRouterRef: {
        current: { dispatchReconnect } as unknown as WebSyncRouter,
      },
    });
    const handler = createReconcileOnReopen(deps);

    handler.handleSseOpened({ assistantId: "asst-1", cause: "error" });
    await new Promise((r) => setTimeout(r, 0));

    expect(dispatchReconnect).toHaveBeenCalledTimes(1);
    // The standalone fallback is in the SAME try block as the sync-
    // router call; both await targets sit on the same try, so a sync-
    // router rejection short-circuits before `reconcileActive` is
    // reached. Important: the failure mode is "transport recovery
    // failed", not "let's try the other path."
    expect(reconcileActive).not.toHaveBeenCalled();
    expect(startReconciliationLoop).not.toHaveBeenCalled();
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
  });
});
