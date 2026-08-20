/**
 * Tests for `useSubagentReconcile`, when the hook asks the daemon to resync
 * this conversation's subagents. Mocks the generated `subagentsReconcileGet`
 * so each trigger is a countable round-trip; the reconcile's effect on the
 * store is covered by `subagent-store.test.ts`.
 *
 * The store throttles the conversation-load pass per parent conversation, but
 * not a reopen: a stream replaced after a drop is the one that may have lost a
 * terminal status, so its reconcile is issued inside the window too.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  setSystemTime,
  test,
} from "bun:test";
import { cleanup, renderHook, waitFor } from "@testing-library/react";

import { __resetForTesting, publish } from "@/lib/event-bus";

/** Stands in for the assistant version the identity store hydrates async. */
let reconcileSupported = true;
mock.module("@/lib/backwards-compat/subagents-reconcile", () => ({
  supportsSubagentsReconcile: () => reconcileSupported,
  useSupportsSubagentsReconcile: () => reconcileSupported,
}));

let getCalls = 0;
mock.module("@/generated/daemon/sdk.gen", () => ({
  subagentsReconcileGet: async () => {
    getCalls += 1;
    return { data: { subagents: {} }, response: { ok: true, status: 200 } };
  },
  subagentsByIdAbortPost: async () => ({
    data: undefined,
    response: { ok: true },
  }),
  subagentsByIdGet: async () => ({
    data: undefined,
    response: { ok: false },
  }),
}));
mock.module("@/lib/sentry/capture-error", () => ({ captureError: () => {} }));

const { useSubagentReconcile } = await import(
  "@/domains/chat/hooks/use-subagent-reconcile"
);
const { useSubagentStore } = await import("@/domains/chat/subagent-store");

const ASSISTANT = "asst-1";
const CONVERSATION = "conv-A";

function mount(
  assistantId: string | null = ASSISTANT,
  conversationId: string | null = CONVERSATION,
  existsOnServer = true,
) {
  return renderHook(() =>
    useSubagentReconcile(assistantId, conversationId, existsOnServer),
  );
}

beforeEach(() => {
  getCalls = 0;
  reconcileSupported = true;
  setSystemTime();
  __resetForTesting();
  useSubagentStore.getState().reset();
});

afterEach(() => {
  cleanup();
  setSystemTime();
});

describe("useSubagentReconcile", () => {
  test("reconciles once on mount with both ids", async () => {
    mount();

    await waitFor(() => expect(getCalls).toBe(1));
  });

  test("does not reconcile without an assistant id", async () => {
    mount(null);

    await waitFor(() => expect(getCalls).toBe(0));
  });

  test("does not reconcile for a conversation the server has never seen", async () => {
    mount(ASSISTANT, CONVERSATION, false);

    await waitFor(() => expect(getCalls).toBe(0));
  });

  test("holds the load pass until the assistant version resolves", async () => {
    // A cold load mounts before the identity fetch lands, so the gate reads
    // `false` first. Snapshotted once, the conversation-load pass, the only
    // trigger a silent run has, would be skipped for the whole session.
    reconcileSupported = false;
    const { rerender } = mount();
    await waitFor(() => expect(getCalls).toBe(0));

    reconcileSupported = true;
    rerender();

    await waitFor(() => expect(getCalls).toBe(1));
    // And exactly once: a later re-render must not re-fire it.
    rerender();
    await waitFor(() => expect(getCalls).toBe(1));
  });

  test("reconciles again when the SSE stream reopens on resume", async () => {
    mount();
    await waitFor(() => expect(getCalls).toBe(1));

    publish("sse.opened", { assistantId: ASSISTANT, cause: "resume" });

    await waitFor(() => expect(getCalls).toBe(2));
  });

  test("reconciles on a reopen inside the load pass's throttle window", async () => {
    // The dropped stream may have straddled a terminal status, and nothing
    // retries a reconcile the window swallowed, the row stays `running`
    // forever. The reactive version gate makes this the common case: the load
    // pass often runs late, moments before the reopen.
    mount();
    await waitFor(() => expect(getCalls).toBe(1));

    publish("sse.opened", { assistantId: ASSISTANT, cause: "error" });

    await waitFor(() => expect(getCalls).toBe(2));
  });

  test("a flap that reopens repeatedly in one tick costs one round-trip", async () => {
    // Bypassing the throttle doesn't mean one request per reopen: the store
    // single-flights per parent conversation.
    mount();
    await waitFor(() => expect(getCalls).toBe(1));

    for (const cause of ["error", "watchdog", "resume"] as const) {
      publish("sse.opened", { assistantId: ASSISTANT, cause });
    }

    await waitFor(() => expect(getCalls).toBe(2));
  });

  test("ignores a fresh open: the mount effect already owns that load", async () => {
    mount();
    await waitFor(() => expect(getCalls).toBe(1));

    publish("sse.opened", { assistantId: ASSISTANT, cause: "fresh" });
    publish("sse.opened", { assistantId: ASSISTANT, cause: "anchor" });

    await waitFor(() => expect(getCalls).toBe(1));
  });

  test("ignores a reopen for a different assistant", async () => {
    mount();
    await waitFor(() => expect(getCalls).toBe(1));

    publish("sse.opened", { assistantId: "asst-other", cause: "watchdog" });

    await waitFor(() => expect(getCalls).toBe(1));
  });

  test("stops reconciling after unmount", async () => {
    const { unmount } = mount();
    await waitFor(() => expect(getCalls).toBe(1));

    unmount();
    publish("sse.opened", { assistantId: ASSISTANT, cause: "error" });

    await waitFor(() => expect(getCalls).toBe(1));
  });
});
