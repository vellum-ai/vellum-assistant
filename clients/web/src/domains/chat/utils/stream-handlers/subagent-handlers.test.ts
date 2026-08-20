/**
 * Unit tests for the subagent stream handlers' conversation-id routing and
 * missed-spawn recovery (LUM-2875).
 *
 * Routing: the `subagent_event` envelope carries the PARENT conversation id
 * and the inner event carries the subagent's own (CHILD) id. They land in
 * separate entry fields: `parentConversationId` scopes the Active-Subagents
 * overlay, `conversationId` addresses the detail fetch, so neither can be
 * mistaken for the other.
 *
 * Recovery: a `subagent_event` or `subagent_status_changed` for an id the
 * store has never seen must materialize a stub instead of being silently
 * dropped: a dropped event chain is how the inline subagent card dies (the
 * avatar row expands to nothing and the detail panel can't open). The
 * backwards-compat gate decides whether a stub that only knows the parent id
 * is armed for detail backfill: only 0.11.0+ daemons resolve the subagent's
 * own conversation themselves, so on older daemons the parent id is useless
 * (a fetch with it would parse the parent's messages as the subagent's).
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";

import type { StreamHandlerContext } from "@/domains/chat/utils/stream-handlers/types";

let selfLookupSupported = true;
mock.module("@/lib/backwards-compat/subagent-detail-self-lookup", () => ({
  supportsSubagentDetailSelfLookup: () => selfLookupSupported,
}));

mock.module("@/lib/backwards-compat/subagents-reconcile", () => ({
  supportsSubagentsReconcile: () => true,
}));

let reconcileCalls = 0;
const reconciledParents: string[] = [];
mock.module("@/generated/daemon/sdk.gen", () => ({
  subagentsReconcileGet: async (options: {
    query?: { parentConversationId?: string };
  }) => {
    reconcileCalls += 1;
    reconciledParents.push(options.query?.parentConversationId ?? "");
    return { data: { subagents: {} }, response: { ok: true, status: 200 } };
  },
  subagentsByIdGet: async () => ({ data: undefined, response: { ok: false } }),
  subagentsByIdAbortPost: async () => ({
    data: undefined,
    response: { ok: true },
  }),
}));

const {
  handleSubagentEvent,
  handleSubagentSpawned,
  handleSubagentStatusChanged,
} = await import("@/domains/chat/utils/stream-handlers/subagent-handlers");
const { useSubagentStore } = await import("@/domains/chat/subagent-store");
const { useConversationStore } = await import("@/stores/conversation-store");
const { useResolvedAssistantsStore } = await import(
  "@/stores/resolved-assistants-store"
);
const { makeCtx } = await import(
  "@/domains/chat/utils/stream-handlers/test-helpers"
);

const PARENT = "conv-parent";
const CHILD = "conv-child";
const BACKGROUND = "conv-background";

const ctx = {} as StreamHandlerContext;

beforeEach(() => {
  // Also clears the reconcile-kick debounce window.
  useSubagentStore.getState().reset();
  selfLookupSupported = true;
  reconcileCalls = 0;
  reconciledParents.length = 0;
  useResolvedAssistantsStore.getState().setActiveAssistantId(null);
  useConversationStore.getState().setActiveConversationId(null);
});

describe("handleSubagentSpawned", () => {
  it("stamps the parent conversation id from the spawn event", () => {
    handleSubagentSpawned(
      {
        type: "subagent_spawned",
        subagentId: "sa-1",
        parentConversationId: PARENT,
        label: "Agent",
        objective: "Task",
      },
      makeCtx(),
    );

    const entry = useSubagentStore.getState().byId["sa-1"];
    expect(entry?.parentConversationId).toBe(PARENT);
    expect(entry?.conversationId).toBeUndefined();
  });
});

describe("handleSubagentEvent: known subagent id", () => {
  function spawn() {
    useSubagentStore.getState().spawnSubagent({
      subagentId: "sa-1",
      label: "auditor",
      objective: "audit",
      timestamp: Date.now(),
    });
  }

  it("routes the envelope id to parent and the inner id to child", () => {
    spawn();

    handleSubagentEvent(
      {
        type: "subagent_event",
        conversationId: PARENT,
        subagentId: "sa-1",
        event: {
          type: "assistant_text_delta",
          text: "hello",
          conversationId: CHILD,
        },
      },
      ctx,
    );

    const entry = useSubagentStore.getState().byId["sa-1"];
    expect(entry?.conversationId).toBe(CHILD);
    expect(entry?.parentConversationId).toBe(PARENT);
    expect(entry?.label).toBe("auditor");
    expect(entry?.events).toHaveLength(1);
  });

  it("never writes the parent id into the child field", () => {
    spawn();

    // Malformed envelope: the inner event echoes the parent id.
    handleSubagentEvent(
      {
        type: "subagent_event",
        conversationId: PARENT,
        subagentId: "sa-1",
        event: {
          type: "assistant_text_delta",
          text: "hello",
          conversationId: PARENT,
        },
      },
      ctx,
    );

    const entry = useSubagentStore.getState().byId["sa-1"];
    expect(entry?.conversationId).toBeUndefined();
    expect(entry?.parentConversationId).toBe(PARENT);
  });
});

describe("handleSubagentEvent — unknown subagent id", () => {
  const eventWithoutChildId = {
    type: "subagent_event" as const,
    subagentId: "sa-1",
    conversationId: PARENT,
    event: { type: "assistant_text_delta", text: "working…" },
  };

  it("materializes a stub carrying both ids when the inner event knows the child", () => {
    handleSubagentEvent(
      {
        ...eventWithoutChildId,
        event: {
          type: "assistant_text_delta",
          text: "working…",
          conversationId: CHILD,
        },
      },
      ctx,
    );

    const entry = useSubagentStore.getState().byId["sa-1"];
    expect(entry).toBeDefined();
    expect(entry?.status).toBe("running");
    expect(entry?.conversationId).toBe(CHILD);
    expect(entry?.parentConversationId).toBe(PARENT);
    expect(entry?.hydrationPending).toBe(true);
    // The triggering event is deferred to the authoritative backfill.
    expect(entry?.events).toEqual([]);
  });

  it("arms a child-id stub on a pre-0.11.0 daemon too", () => {
    selfLookupSupported = false;

    handleSubagentEvent(
      {
        ...eventWithoutChildId,
        event: {
          type: "assistant_text_delta",
          text: "working…",
          conversationId: CHILD,
        },
      },
      ctx,
    );

    const entry = useSubagentStore.getState().byId["sa-1"];
    expect(entry?.conversationId).toBe(CHILD);
    expect(entry?.hydrationPending).toBe(true);
  });

  it("arms a parent-only stub on a self-lookup daemon", () => {
    handleSubagentEvent(eventWithoutChildId, ctx);

    const entry = useSubagentStore.getState().byId["sa-1"];
    expect(entry).toBeDefined();
    // The parent id never enters the child-semantic field, even armed.
    expect(entry?.conversationId).toBeUndefined();
    expect(entry?.parentConversationId).toBe(PARENT);
    expect(entry?.hydrationPending).toBe(true);
    expect(entry?.events).toEqual([]);
  });

  it("materializes an un-armed stub on a pre-0.11.0 daemon", () => {
    selfLookupSupported = false;

    handleSubagentEvent(eventWithoutChildId, ctx);

    const entry = useSubagentStore.getState().byId["sa-1"];
    expect(entry).toBeDefined();
    // No id an old daemon can resolve: it would trust the parent id verbatim
    // and parse the PARENT conversation's messages as the subagent's.
    expect(entry?.conversationId).toBeUndefined();
    expect(entry?.parentConversationId).toBe(PARENT);
    expect(entry?.hydrationPending).toBeUndefined();
    // Un-armed stubs accrue the live stream instead.
    expect(entry?.events).toHaveLength(1);
  });
});

describe("handleSubagentStatusChanged: unknown subagent id", () => {
  it("materializes a stub carrying the status instead of dropping it", () => {
    handleSubagentStatusChanged(
      {
        type: "subagent_status_changed",
        subagentId: "sa-9",
        status: "completed",
        usage: { inputTokens: 10, outputTokens: 5, estimatedCost: 0.02 },
      },
      ctx,
    );

    const entry = useSubagentStore.getState().byId["sa-9"];
    expect(entry).toBeDefined();
    expect(entry?.status).toBe("completed");
    expect(entry?.inputTokens).toBe(10);
    // The event carries no conversation ids, and with no conversation on
    // screen there is nothing to fall back to either.
    expect(entry?.conversationId).toBeUndefined();
    expect(entry?.parentConversationId).toBeUndefined();
    expect(entry?.hydrationPending).toBeUndefined();
  });

  it("scopes the stub to the conversation on screen", () => {
    // A status event names no conversation, and an entry with no parent id is
    // shown by the Active-Subagents overlay in EVERY conversation while
    // reconcile's per-parent orphan pass settles it in none.
    useConversationStore.getState().setActiveConversationId(PARENT);

    handleSubagentStatusChanged(
      { type: "subagent_status_changed", subagentId: "sa-9", status: "running" },
      ctx,
    );

    const entry = useSubagentStore.getState().byId["sa-9"];
    expect(entry?.parentConversationId).toBe(PARENT);
    // The parent id addresses the backfill on a self-lookup daemon, so the
    // stub now defers its live events until the fetch lands.
    expect(entry?.conversationId).toBeUndefined();
    expect(entry?.hydrationPending).toBe(true);
  });
});

describe("unknown-id reconcile kick", () => {
  function activate() {
    useResolvedAssistantsStore.getState().setActiveAssistantId("asst-1");
    useConversationStore.getState().setActiveConversationId(PARENT);
  }

  function statusEvent(subagentId: string) {
    return {
      type: "subagent_status_changed" as const,
      subagentId,
      status: "running" as const,
    };
  }

  it("kicks a reconcile for an unknown status-change id", async () => {
    activate();

    handleSubagentStatusChanged(statusEvent("sa-1"), ctx);
    await Promise.resolve();

    expect(reconcileCalls).toBe(1);
  });

  it("collapses a burst of unknown ids into one round-trip", async () => {
    activate();

    handleSubagentStatusChanged(statusEvent("sa-1"), ctx);
    handleSubagentStatusChanged(statusEvent("sa-2"), ctx);
    handleSubagentEvent(
      {
        type: "subagent_event",
        subagentId: "sa-3",
        conversationId: PARENT,
        event: { type: "assistant_text_delta", text: "working…" },
      },
      ctx,
    );
    await Promise.resolve();

    expect(reconcileCalls).toBe(1);
    // Every id still got its own stub: the kick is additive, not a substitute.
    expect(useSubagentStore.getState().orderedIds).toEqual([
      "sa-1",
      "sa-2",
      "sa-3",
    ]);
  });

  it("does not kick for an id the store already knows", async () => {
    activate();
    useSubagentStore.getState().spawnSubagent({
      subagentId: "sa-1",
      label: "auditor",
      objective: "audit",
      timestamp: Date.now(),
    });

    handleSubagentStatusChanged(statusEvent("sa-1"), ctx);
    await Promise.resolve();

    expect(reconcileCalls).toBe(0);
  });

  it("does not kick without an active assistant and conversation", async () => {
    handleSubagentStatusChanged(statusEvent("sa-1"), ctx);
    await Promise.resolve();

    expect(reconcileCalls).toBe(0);
  });

  it("reconciles the event's own parent, not the conversation on screen", async () => {
    activate();

    // Subagent events are routed globally, so this one belongs to a
    // conversation running in the background.
    handleSubagentEvent(
      {
        type: "subagent_event",
        subagentId: "sa-bg",
        conversationId: BACKGROUND,
        event: { type: "assistant_text_delta", text: "working…" },
      },
      ctx,
    );
    await Promise.resolve();

    expect(reconciledParents).toEqual([BACKGROUND]);
  });

  it("throttles per parent so a background kick can't starve the active one", async () => {
    activate();

    handleSubagentEvent(
      {
        type: "subagent_event",
        subagentId: "sa-bg",
        conversationId: BACKGROUND,
        event: { type: "assistant_text_delta", text: "working…" },
      },
      ctx,
    );
    // Inside the background parent's 5s window, but the active parent has a
    // window of its own.
    handleSubagentStatusChanged(statusEvent("sa-active"), ctx);
    // A second background kick is still throttled.
    handleSubagentEvent(
      {
        type: "subagent_event",
        subagentId: "sa-bg-2",
        conversationId: BACKGROUND,
        event: { type: "assistant_text_delta", text: "working…" },
      },
      ctx,
    );
    await Promise.resolve();

    expect(reconciledParents).toEqual([BACKGROUND, PARENT]);
  });

  it("targets the active conversation for a status change, which carries no ids", async () => {
    activate();

    handleSubagentStatusChanged(statusEvent("sa-1"), ctx);
    await Promise.resolve();

    expect(reconciledParents).toEqual([PARENT]);
  });
});
