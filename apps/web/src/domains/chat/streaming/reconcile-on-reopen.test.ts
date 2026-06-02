import { beforeEach, describe, expect, mock, test } from "bun:test";

import type {
  ActiveConversationMessagesRefreshResult,
  WebSyncReconnectResult,
} from "@/lib/sync/web-sync-router";

// Mock stream store — tracks epoch so tests can simulate races.
let mockStreamEpoch = 0;
mock.module("@/domains/chat/stream-store", () => ({
  useStreamStore: {
    getState: () => ({
      streamEpoch: mockStreamEpoch,
      bumpEpoch: () => {
        mockStreamEpoch++;
        return mockStreamEpoch;
      },
    }),
  },
}));

const recordDiagnosticMock = mock(() => {});
const recordLifecycleDiagnosticMock = mock(() => {});
const bucketMessagesAddedMock = mock(() => "0");
const resolvePlatformTagMock = mock(() => "web");
mock.module("@/lib/diagnostics", () => ({
  recordDiagnostic: recordDiagnosticMock,
  recordLifecycleDiagnostic: recordLifecycleDiagnosticMock,
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
  reconcileActive: () => Promise<ActiveConversationMessagesRefreshResult>;
  startReconciliationLoop: (epoch: number) => void;
  dispatchReconnect: () => Promise<WebSyncReconnectResult | undefined>;
}> = {}) => {
  const reconcileActive = override.reconcileActive ?? mock(async () => makeReconcileResult());
  const startReconciliationLoop = override.startReconciliationLoop ?? mock(() => {});
  const dispatchReconnect = override.dispatchReconnect ?? mock(async () => undefined);
  return {
    reconcileActive,
    startReconciliationLoop,
    dispatchReconnect,
    deps: {
      assistantId: override.assistantId ?? "asst-1",
      conversationId: override.conversationId ?? "conv-1",
      reconcileActive,
      startReconciliationLoop,
      dispatchReconnect,
    },
  };
};

beforeEach(() => {
  mockStreamEpoch = 0;
  recordDiagnosticMock.mockClear();
  recordLifecycleDiagnosticMock.mockClear();
  addBreadcrumbMock.mockClear();
  captureMessageMock.mockClear();
  captureExceptionMock.mockClear();
});

describe("reconcile-on-reopen — gating", () => {
  test("ignores opens for a different assistant", () => {
    const { deps, reconcileActive, startReconciliationLoop } =
      makeDeps();
    const handler = createReconcileOnReopen(deps);

    handler.handleSseOpened({ assistantId: "asst-OTHER", cause: "resume" });

    expect(mockStreamEpoch).toBe(0);
    expect(reconcileActive).not.toHaveBeenCalled();
    expect(startReconciliationLoop).not.toHaveBeenCalled();
  });

  test("fresh cause: bumps epoch but does not reconcile", () => {
    const { deps, reconcileActive, startReconciliationLoop } =
      makeDeps();
    const handler = createReconcileOnReopen(deps);

    handler.handleSseOpened({ assistantId: "asst-1", cause: "fresh" });

    expect(mockStreamEpoch).toBe(1);
    expect(reconcileActive).not.toHaveBeenCalled();
    expect(startReconciliationLoop).not.toHaveBeenCalled();
    // AND the open is recorded on the durable lifecycle ring, not the
    // high-volume main ring, so it survives a long streaming session.
    expect(recordLifecycleDiagnosticMock).toHaveBeenCalledWith(
      "sse_stream_opened",
      expect.objectContaining({ cause: "fresh" }),
    );
  });
});

describe("reconcile-on-reopen — resume cause", () => {
  test("standalone reconcile + start the loop on the bumped epoch", () => {
    const { deps, reconcileActive, startReconciliationLoop } =
      makeDeps();
    const handler = createReconcileOnReopen(deps);

    handler.handleSseOpened({ assistantId: "asst-1", cause: "resume" });

    expect(mockStreamEpoch).toBe(1);
    expect(reconcileActive).toHaveBeenCalledTimes(1);
    expect(startReconciliationLoop).toHaveBeenCalledWith(1);
  });

  test("reconcile rejection: logs to Sentry, does NOT block the loop start, does not propagate", async () => {
    // Resume path is parallel-fire by design — the loop is the
    // primary catch-up mechanism, so a one-shot reconcile failure
    // shouldn't stop it from running. The catch just logs the
    // rejection instead of letting it surface as an unhandled
    // promise rejection.
    const reconcileActive = mock(async () => {
      throw new Error("daemon timeout");
    });
    const { deps, startReconciliationLoop } = makeDeps({ reconcileActive });
    const handler = createReconcileOnReopen(deps);

    handler.handleSseOpened({ assistantId: "asst-1", cause: "resume" });

    // Loop start is synchronous and unconditional.
    expect(startReconciliationLoop).toHaveBeenCalledWith(1);

    // Let the rejected promise settle so the .catch fires.
    await new Promise((r) => setTimeout(r, 0));

    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
  });
});

describe("reconcile-on-reopen — transport recovery (watchdog / error)", () => {
  test("watchdog with sync router available: uses sync router result, no fallback reconcile", async () => {
    const dispatchReconnect = mock(async () => ({
      dispatch: { handledTags: [], unknownTags: [], invokedHandlers: 0, errors: [] },
      activeConversationMessages: makeReconcileResult({ messagesAdded: 3 }),
    }));
    const { deps, reconcileActive, startReconciliationLoop } = makeDeps({
      dispatchReconnect,
    });
    const handler = createReconcileOnReopen(deps);

    handler.handleSseOpened({ assistantId: "asst-1", cause: "watchdog" });
    await new Promise((r) => setTimeout(r, 0));

    expect(dispatchReconnect).toHaveBeenCalledTimes(1);
    expect(reconcileActive).not.toHaveBeenCalled();
    expect(startReconciliationLoop).toHaveBeenCalledWith(1);
    // AND the reconnect is recorded on the durable lifecycle ring.
    expect(recordLifecycleDiagnosticMock).toHaveBeenCalledWith(
      "sse_stream_reconnect",
      expect.objectContaining({ cause: "watchdog" }),
    );
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
    const { deps, startReconciliationLoop } = makeDeps({
      reconcileActive,
    });
    const handler = createReconcileOnReopen(deps);

    handler.handleSseOpened({ assistantId: "asst-1", cause: "watchdog" });
    expect(mockStreamEpoch).toBe(1);

    // Simulate a racing later reopen: bump the epoch before the
    // in-flight reconcile resolves.
    mockStreamEpoch = 2;
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

  test("standalone reconcile rejection: logs to Sentry, still starts the polling loop, does not propagate", async () => {
    // No sync router, so the code falls back to `reconcileActive()`.
    // That fallback rejects; the handler must log + start the polling
    // loop (primary catch-up mechanism) without surfacing an unhandled
    // promise rejection. The watchdog rescue metric is NOT recorded
    // because we have no reconcile result to measure.
    const reconcileActive = mock(async () => {
      throw new Error("daemon unreachable");
    });
    const { deps, startReconciliationLoop } = makeDeps({ reconcileActive });
    const handler = createReconcileOnReopen(deps);

    handler.handleSseOpened({ assistantId: "asst-1", cause: "watchdog" });
    await new Promise((r) => setTimeout(r, 0));

    expect(reconcileActive).toHaveBeenCalledTimes(1);
    expect(startReconciliationLoop).toHaveBeenCalledWith(1);
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    expect(captureMessageMock).not.toHaveBeenCalled();
  });

  test("sync-router dispatchReconnect rejection: logs to Sentry, does not fall back to reconcileActive, still starts the polling loop", async () => {
    const dispatchReconnect = mock(async () => {
      throw new Error("sync router transport failed");
    });
    const reconcileActive = mock(async () => makeReconcileResult());
    const { deps, startReconciliationLoop } = makeDeps({
      reconcileActive,
      dispatchReconnect,
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
    // The polling loop still starts — it's the primary catch-up
    // mechanism and must not be blocked by a transient fetch failure.
    expect(startReconciliationLoop).toHaveBeenCalledWith(1);
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
  });
});
