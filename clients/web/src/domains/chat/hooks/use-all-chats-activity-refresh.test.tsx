import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";

import { __resetForTesting, publish } from "@/lib/event-bus";

let ready = true;
let supportsSubagents = true;
const reads: Array<{ kind: string; assistantId: string; id: string }> = [];
const pending: Array<() => boolean> = [];
let holdAcp: Promise<void> | undefined;

mock.module("@/hooks/use-is-org-ready", () => ({ useIsOrgReady: () => ready }));
mock.module("@/lib/backwards-compat/subagents-reconcile", () => ({
  useSupportsSubagentsReconcile: () => supportsSubagents,
}));
mock.module("@/domains/chat/subagent-store", () => ({
  useSubagentStore: {
    getState: () => ({
      byId: { "agent-1": { parentConversationId: "conv-1" } },
      reconcileFromDaemon: async (assistantId: string, id: string) => {
        reads.push({ kind: "subagent", assistantId, id });
      },
    }),
  },
}));
mock.module("@/domains/chat/acp-run-store", () => ({
  useAcpRunStore: { getState: () => ({ byId: {} }) },
}));
mock.module("@/domains/chat/hooks/use-acp-run-rehydration", () => ({
  reconcileAcpSessions: async (
    assistantId: string,
    id: string,
    isCurrent: () => boolean,
    restorePrompt: boolean,
  ) => {
    expect(restorePrompt).toBe(false);
    reads.push({ kind: "acp", assistantId, id });
    pending.push(isCurrent);
    await holdAcp;
  },
}));
mock.module("@/domains/chat/hooks/use-background-task-rehydration", () => ({
  reconcileBackgroundTasks: async (assistantId: string, id: string) => {
    reads.push({ kind: "tool", assistantId, id });
  },
}));

const { useAllChatsActivityRefresh } =
  await import("./use-all-chats-activity-refresh");

beforeEach(() => {
  ready = true;
  supportsSubagents = true;
  reads.length = 0;
  pending.length = 0;
  holdAcp = undefined;
  __resetForTesting();
});
afterEach(cleanup);

function mount() {
  return renderHook(
    ({ assistantId, enabled }) =>
      useAllChatsActivityRefresh(assistantId, enabled),
    {
      initialProps: { assistantId: "assistant-1", enabled: true },
    },
  );
}

test("waits for org readiness and hydrates only registered rows", async () => {
  ready = false;
  const hook = mount();
  act(() => {
    hook.result.current("conv-1");
  });
  expect(reads).toHaveLength(0);
  ready = true;
  hook.rerender({ assistantId: "assistant-1", enabled: true });
  await waitFor(() => expect(reads).toHaveLength(3));
  expect(reads.every((read) => read.id === "conv-1")).toBe(true);
});

test("refreshes the owning closed chat on task lifecycle events without fetching on text deltas", async () => {
  const hook = mount();
  act(() => {
    hook.result.current("conv-1");
    hook.result.current("conv-2");
  });
  await waitFor(() => expect(reads).toHaveLength(6));
  act(() =>
    publish("sse.event", {
      id: "event-1",
      seq: 1,
      emittedAt: "2026-09-24T12:00:00Z",
      conversationId: "conv-2",
      message: { type: "assistant_text_delta", text: "Hello" },
    }),
  );
  expect(reads).toHaveLength(6);
  act(() =>
    publish("sse.event", {
      id: "event-2",
      seq: 2,
      emittedAt: "2026-09-24T12:00:01Z",
      message: {
        type: "subagent_status_changed",
        subagentId: "agent-1",
        status: "completed",
      },
    }),
  );
  await waitFor(() => expect(reads).toHaveLength(9));
  expect(reads.slice(6).every((read) => read.id === "conv-1")).toBe(true);
});

test("reconciles on reconnect and resume, ignoring another assistant's reconnect", async () => {
  const hook = mount();
  act(() => {
    hook.result.current("conv-1");
  });
  await waitFor(() => expect(reads).toHaveLength(3));
  act(() =>
    publish("sse.opened", { assistantId: "assistant-2", cause: "resume" }),
  );
  expect(reads).toHaveLength(3);
  act(() =>
    publish("sse.opened", { assistantId: "assistant-1", cause: "resume" }),
  );
  await waitFor(() => expect(reads).toHaveLength(6));
  act(() => publish("app.resume", { signal: "visibility" }));
  await waitFor(() => expect(reads).toHaveLength(9));
});

test("retires pending reads when switching assistants", async () => {
  let release!: () => void;
  holdAcp = new Promise<void>((resolve) => {
    release = resolve;
  });
  const hook = mount();
  act(() => {
    hook.result.current("conv-1");
  });
  await waitFor(() => expect(pending).toHaveLength(1));
  hook.rerender({ assistantId: "assistant-2", enabled: true });
  expect(pending[0]!()).toBe(false);
  await act(async () => {
    release();
  });
  expect(reads.some((read) => read.kind === "tool")).toBe(false);
  act(() => {
    hook.result.current("conv-2");
  });
  await waitFor(() => expect(reads).toHaveLength(5));
  expect(
    reads.slice(2).every((read) => read.assistantId === "assistant-2"),
  ).toBe(true);
});

test("skips unsupported subagents and stops reads when disabled", async () => {
  supportsSubagents = false;
  const hook = mount();
  act(() => {
    hook.result.current("conv-1");
  });
  await waitFor(() => expect(reads).toHaveLength(2));
  expect(reads.map((read) => read.kind)).toEqual(["acp", "tool"]);
  hook.rerender({ assistantId: "assistant-1", enabled: false });
  act(() => publish("app.resume", { signal: "visibility" }));
  expect(reads).toHaveLength(2);
});
