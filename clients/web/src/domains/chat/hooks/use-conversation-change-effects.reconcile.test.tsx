/**
 * Tests for the reconcile-on-load path of `useConversationChangeEffects`
 * (LUM-2875): on 0.10.13+ daemons, loading a conversation asks
 * `subagents/reconcile` for every subagent the daemon knows about and
 * materializes store entries for the ones this client never saw spawn.
 * Split from the main test file so the SDK/gate mocks can't perturb the
 * reset-ordering tests there.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";

import * as realSdk from "@/generated/daemon/sdk.gen";

let recoverySupported = true;
mock.module("@/lib/backwards-compat/subagent-recovery", () => ({
  supportsSubagentRecovery: () => recoverySupported,
  useSupportsSubagentRecovery: () => recoverySupported,
}));

let reconcileCalls: Array<Record<string, unknown>> = [];
let reconcileResponse: {
  subagents: Record<
    string,
    {
      status: string;
      label?: string;
      conversationId?: string;
      parentToolUseId?: string;
    }
  >;
} = { subagents: {} };

mock.module("@/generated/daemon/sdk.gen", () => ({
  // The import graph (workflow store, subagent store) reaches many other
  // SDK operations — keep them real and override only what this test drives.
  ...realSdk,
  subagentsReconcileGet: (options: Record<string, unknown>) => {
    reconcileCalls.push(options);
    return Promise.resolve({
      data: reconcileResponse,
      response: { ok: true },
    });
  },
  // Pulled in via subagent-store's detail action — inert so an armed stub's
  // backfill never fires a real network call here.
  subagentsByIdGet: () =>
    Promise.resolve({ data: undefined, response: { ok: false } }),
}));

const { useConversationChangeEffects } = await import(
  "@/domains/chat/hooks/use-conversation-change-effects"
);
const { useSubagentStore } = await import("@/domains/chat/subagent-store");
const { useConversationStore } = await import("@/stores/conversation-store");

function Harness({ conversationId }: { conversationId: string }) {
  useConversationChangeEffects("asst-1", conversationId);
  return null;
}

beforeEach(() => {
  reconcileCalls = [];
  reconcileResponse = { subagents: {} };
  recoverySupported = true;
  useSubagentStore.getState().reset();
  useConversationStore.getState().setActiveConversationId("conv-A");
});

afterEach(() => {
  cleanup();
  useSubagentStore.getState().reset();
});

describe("useConversationChangeEffects — reconcile-on-load", () => {
  test("materializes entries for daemon-known subagents the store lacks", async () => {
    reconcileResponse = {
      subagents: {
        "sa-1": {
          status: "running",
          label: "Audit daemon defenses",
          conversationId: "conv-child-1",
          parentToolUseId: "toolu_1",
        },
        "sa-2": {
          status: "completed",
          label: "Citation matrix",
          conversationId: "conv-child-2",
        },
      },
    };

    render(<Harness conversationId="conv-A" />);

    await waitFor(() =>
      expect(useSubagentStore.getState().byId["sa-1"]).toBeDefined(),
    );
    const state = useSubagentStore.getState();
    expect(state.byId["sa-1"]?.label).toBe("Audit daemon defenses");
    expect(state.byId["sa-1"]?.status).toBe("running");
    expect(state.byId["sa-1"]?.conversationId).toBe("conv-child-1");
    expect(state.byToolUseId.get("toolu_1")).toBe("sa-1");
    expect(state.byId["sa-2"]?.status).toBe("completed");
    expect(reconcileCalls[0]).toMatchObject({
      query: { parentConversationId: "conv-A" },
    });
  });

  test("leaves an entry that appears while the fetch is in flight untouched", async () => {
    reconcileResponse = {
      subagents: {
        "sa-1": { status: "completed", label: "stale label" },
      },
    };

    render(<Harness conversationId="conv-A" />);
    // A live `subagent_spawned` lands after the fetch was issued but before
    // its continuation applies (render flushes effects synchronously; the
    // mocked promise's continuation runs on the next microtask). ensureEntry
    // must not clobber it with the reconcile snapshot.
    useSubagentStore.getState().spawnSubagent({
      subagentId: "sa-1",
      label: "live label",
      objective: "obj",
      status: "running",
      timestamp: Date.now(),
    });

    await waitFor(() => expect(reconcileCalls.length).toBe(1));
    const entry = useSubagentStore.getState().byId["sa-1"];
    expect(entry?.label).toBe("live label");
    expect(entry?.status).toBe("running");
  });

  test("skips entirely on a pre-0.10.13 daemon", async () => {
    recoverySupported = false;
    reconcileResponse = {
      subagents: { "sa-1": { status: "running", label: "x" } },
    };

    render(<Harness conversationId="conv-A" />);

    await new Promise((r) => setTimeout(r, 20));
    expect(reconcileCalls.length).toBe(0);
    expect(useSubagentStore.getState().byId["sa-1"]).toBeUndefined();
  });

  test("discards a response that lands after a conversation switch", async () => {
    reconcileResponse = {
      subagents: { "sa-1": { status: "running", label: "x" } },
    };

    render(<Harness conversationId="conv-A" />);
    // Switch the active conversation before the (already-resolved) promise's
    // continuation applies — the guard reads the store at apply time.
    useConversationStore.getState().setActiveConversationId("conv-B");

    await new Promise((r) => setTimeout(r, 20));
    expect(useSubagentStore.getState().byId["sa-1"]).toBeUndefined();
  });
});
