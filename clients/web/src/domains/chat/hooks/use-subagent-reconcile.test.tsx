/**
 * Tests for `useSubagentReconcile` — when the hook asks the daemon to resync
 * this conversation's subagents. Mocks the generated `subagentsReconcileGet`
 * so each trigger is a countable round-trip; the reconcile's effect on the
 * store is covered by `subagent-store.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, renderHook, waitFor } from "@testing-library/react";

import { __resetForTesting, publish } from "@/lib/event-bus";

mock.module("@/lib/backwards-compat/subagents-reconcile", () => ({
  supportsSubagentsReconcile: () => true,
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
  __resetForTesting();
  useSubagentStore.getState().reset();
});

afterEach(() => {
  cleanup();
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

  test("reconciles again when the SSE stream reopens on resume", async () => {
    mount();
    await waitFor(() => expect(getCalls).toBe(1));

    publish("sse.opened", { assistantId: ASSISTANT, cause: "resume" });

    await waitFor(() => expect(getCalls).toBe(2));
  });

  test("ignores a fresh open — the mount effect already owns that load", async () => {
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
