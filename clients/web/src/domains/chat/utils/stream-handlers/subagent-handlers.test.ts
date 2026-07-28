/**
 * Unit tests for the subagent stream handlers' missed-spawn recovery
 * (LUM-2875): a `subagent_event` or `subagent_status_changed` for an id the
 * store has never seen must materialize a stub entry instead of being
 * silently dropped — a dropped event chain is how the inline subagent card
 * dies (the avatar row expands to nothing and the detail panel can't open).
 *
 * The backwards-compat gate decides whether the stub is armed for detail
 * backfill with the parent conversation id: only 0.11.0+ daemons resolve
 * the subagent's own conversation themselves, so on older daemons the stub
 * must stay un-armed (a fetch with the parent id would parse the parent's
 * messages as the subagent's).
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";

import type { StreamHandlerContext } from "@/domains/chat/utils/stream-handlers/types";

let selfLookupSupported = true;
mock.module("@/lib/backwards-compat/subagent-recovery", () => ({
  supportsSubagentRecovery: () => selfLookupSupported,
}));

const { handleSubagentEvent, handleSubagentStatusChanged } = await import(
  "@/domains/chat/utils/stream-handlers/subagent-handlers"
);
const { useSubagentStore } = await import("@/domains/chat/subagent-store");

const ctx = {} as StreamHandlerContext;

beforeEach(() => {
  useSubagentStore.getState().reset();
  selfLookupSupported = true;
});

describe("handleSubagentEvent — unknown subagent id", () => {
  const event = {
    type: "subagent_event" as const,
    subagentId: "sa-1",
    conversationId: "conv-parent",
    event: { type: "assistant_text_delta", text: "working…" },
  };

  it("materializes a hydration-pending stub on a self-lookup daemon", () => {
    handleSubagentEvent(event, ctx);

    const entry = useSubagentStore.getState().byId["sa-1"];
    expect(entry).toBeDefined();
    expect(entry?.status).toBe("running");
    expect(entry?.conversationId).toBe("conv-parent");
    expect(entry?.hydrationPending).toBe(true);
    // The triggering event is deferred to the authoritative backfill.
    expect(entry?.events).toEqual([]);
  });

  it("materializes an un-armed stub on a pre-0.11.0 daemon", () => {
    selfLookupSupported = false;

    handleSubagentEvent(event, ctx);

    const entry = useSubagentStore.getState().byId["sa-1"];
    expect(entry).toBeDefined();
    // No conversationId: the old daemon would trust it verbatim and parse
    // the PARENT conversation's messages as the subagent's.
    expect(entry?.conversationId).toBeUndefined();
    expect(entry?.hydrationPending).toBeUndefined();
    // Un-armed stubs accrue the live stream instead.
    expect(entry?.events).toHaveLength(1);
  });

  it("leaves known entries on the historical path", () => {
    useSubagentStore.getState().spawnSubagent({
      subagentId: "sa-1",
      label: "auditor",
      objective: "audit",
      timestamp: Date.now(),
    });

    handleSubagentEvent(event, ctx);

    const entry = useSubagentStore.getState().byId["sa-1"];
    expect(entry?.label).toBe("auditor");
    expect(entry?.conversationId).toBe("conv-parent");
    expect(entry?.events).toHaveLength(1);
  });
});

describe("status-first recovery ordering", () => {
  it("arms a bare status-created stub when a later event supplies the conversation id", () => {
    // `subagent_status_changed` carries no conversationId, so the recovery
    // stub starts un-armed…
    handleSubagentStatusChanged(
      { type: "subagent_status_changed", subagentId: "sa-1", status: "running" },
      ctx,
    );
    const stub = useSubagentStore.getState().byId["sa-1"];
    expect(stub?.conversationId).toBeUndefined();
    expect(stub?.hydrationPending).toBeUndefined();

    // …and the first `subagent_event` must arm it for detail backfill
    // rather than appending (which would strand the placeholder label by
    // failing the auto-fetch's zero-events guard forever).
    handleSubagentEvent(
      {
        type: "subagent_event",
        subagentId: "sa-1",
        conversationId: "conv-parent",
        event: { type: "assistant_text_delta", text: "working…" },
      },
      ctx,
    );
    const armed = useSubagentStore.getState().byId["sa-1"];
    expect(armed?.conversationId).toBe("conv-parent");
    expect(armed?.hydrationPending).toBe(true);
    expect(armed?.events).toEqual([]);
  });
});

describe("handleSubagentStatusChanged — unknown subagent id", () => {
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
  });
});
