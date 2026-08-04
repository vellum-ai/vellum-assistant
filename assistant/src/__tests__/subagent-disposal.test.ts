import { beforeEach, describe, expect, test } from "bun:test";

import type { AssistantEvent } from "../api/index.js";
import { getDb } from "../persistence/db-connection.js";
import { migrateCreateSubagentsTable } from "../persistence/migrations/311-create-subagents-table.js";
import { migrateAddSubagentParentToolUseId } from "../persistence/migrations/356-add-subagent-parent-tool-use-id.js";
import { resetTestTables } from "../persistence/raw-query.js";
import {
  getSubagentRecordById,
  loadAllSubagentRecords,
  type SubagentRecord,
  upsertSubagentRecord,
} from "../persistence/subagent-store.js";
import { SubagentManager } from "../subagent/manager.js";
import type { SubagentState } from "../subagent/types.js";

/** Minimal shape matching the private ManagedSubagent interface for test injection. */
interface FakeManagedSubagent {
  conversation: {
    abort: () => void;
    dispose: () => void;
    messages: Array<{
      role: string;
      content: Array<{ type: string; text: string }>;
    }>;
    sendToClient: (msg: AssistantEvent) => void;
    persistUserMessage?: () => { id: string; deduplicated: boolean };
    runAgentLoop?: () => Promise<void>;
    enqueueMessage?: () => { rejected: boolean; queued: boolean };
    usageStats: {
      inputTokens: number;
      outputTokens: number;
      estimatedCost: number;
    };
    subagentDeniedToolNames: Set<string>;
  } | null;
  state: SubagentState;
  parentSendToClient: (msg: AssistantEvent) => void;
  retainedUntil?: number;
  hadEnqueuedMessages?: boolean;
}

/** Type-safe accessor for SubagentManager's private internals via bracket notation. */
interface ManagerInternals {
  subagents: Map<string, FakeManagedSubagent>;
  parentToChildren: Map<string, Set<string>>;
  labelIndex: Map<string, string>;
  runSubagent: (subagentId: string, objective: string) => Promise<void>;
  sweepTerminal: () => void;
  stopSweep: () => void;
}

function asInternals(manager: SubagentManager): ManagerInternals {
  return manager as unknown as ManagerInternals;
}

function makeFakeConversation(): NonNullable<
  FakeManagedSubagent["conversation"]
> {
  return {
    abort: () => {},
    dispose: () => {},
    messages: [],
    sendToClient: () => {},
    usageStats: { inputTokens: 100, outputTokens: 50, estimatedCost: 0.005 },
    subagentDeniedToolNames: new Set<string>(),
  };
}

function injectFakeSubagent(
  manager: SubagentManager,
  subagentId: string,
  state: SubagentState,
  parentSendToClient?: (msg: AssistantEvent) => void,
  conversation?: FakeManagedSubagent["conversation"],
): void {
  const internals = asInternals(manager);

  internals.subagents.set(subagentId, {
    conversation:
      conversation === undefined ? makeFakeConversation() : conversation,
    state,
    parentSendToClient: parentSendToClient ?? (() => {}),
  });

  const parentId = state.config.parentConversationId;
  if (!internals.parentToChildren.has(parentId)) {
    internals.parentToChildren.set(parentId, new Set());
  }
  internals.parentToChildren.get(parentId)!.add(subagentId);
  internals.labelIndex.set(
    `${parentId}:${state.config.label.toLowerCase().trim()}`,
    subagentId,
  );
}

function makeState(
  subagentId: string,
  overrides: Partial<SubagentState> = {},
): SubagentState {
  return {
    config: {
      id: subagentId,
      parentConversationId: "parent-sess-1",
      label: "Test subagent",
      objective: "Do something",
    },
    status: "running",
    conversationId: "conv-sub-1",
    isFork: false,
    createdAt: Date.now(),
    usage: { inputTokens: 0, outputTokens: 0, estimatedCost: 0 },
    ...overrides,
  };
}

describe("SubagentManager terminal disposal", () => {
  test("completed subagent has conversation === null but state is preserved", async () => {
    const manager = new SubagentManager();
    const subagentId = "sub-1";
    const state = makeState(subagentId);
    injectFakeSubagent(manager, subagentId, state);

    const managed = asInternals(manager).subagents.get(subagentId)!;
    managed.conversation!.persistUserMessage = () => ({
      id: "msg-1",
      deduplicated: false,
    });
    managed.conversation!.runAgentLoop = async () => {};

    await asInternals(manager).runSubagent(subagentId, "Do something");

    expect(state.status).toBe("completed");
    expect(managed.conversation).toBeNull();
    // State is still accessible via getState.
    expect(manager.getState(subagentId)).toBeDefined();
    expect(manager.getState(subagentId)!.status).toBe("completed");
    expect(managed.retainedUntil).toBeGreaterThan(Date.now());

    // Cleanup
    asInternals(manager).stopSweep();
  });

  test("failed subagent releases live conversation", async () => {
    const manager = new SubagentManager();
    const subagentId = "sub-1";
    const state = makeState(subagentId);
    injectFakeSubagent(manager, subagentId, state);

    const managed = asInternals(manager).subagents.get(subagentId)!;
    managed.conversation!.persistUserMessage = () => ({
      id: "msg-1",
      deduplicated: false,
    });
    managed.conversation!.runAgentLoop = async () => {
      throw new Error("LLM error");
    };

    await asInternals(manager).runSubagent(subagentId, "Do something");

    expect(state.status).toBe("failed");
    expect(managed.conversation).toBeNull();
    expect(manager.getState(subagentId)).toBeDefined();

    asInternals(manager).stopSweep();
  });

  test("aborted subagent releases conversation when runSubagent catches", async () => {
    const manager = new SubagentManager();
    const subagentId = "sub-1";
    const state = makeState(subagentId, { status: "aborted" });
    injectFakeSubagent(manager, subagentId, state);

    const managed = asInternals(manager).subagents.get(subagentId)!;
    managed.conversation!.persistUserMessage = () => ({
      id: "msg-1",
      deduplicated: false,
    });
    managed.conversation!.runAgentLoop = async () => {
      throw new Error("Conversation aborted");
    };

    await asInternals(manager).runSubagent(subagentId, "Do something");

    expect(managed.conversation).toBeNull();

    asInternals(manager).stopSweep();
  });

  test("sendMessage returns 'terminal' after conversation is released", async () => {
    const manager = new SubagentManager();
    const subagentId = "sub-1";
    const state = makeState(subagentId);
    injectFakeSubagent(manager, subagentId, state);

    const managed = asInternals(manager).subagents.get(subagentId)!;
    managed.conversation!.persistUserMessage = () => ({
      id: "msg-1",
      deduplicated: false,
    });
    managed.conversation!.runAgentLoop = async () => {};

    await asInternals(manager).runSubagent(subagentId, "Do something");

    expect(managed.conversation).toBeNull();
    const result = await manager.sendMessage(subagentId, "hello");
    expect(result).toBe("terminal");

    asInternals(manager).stopSweep();
  });

  test("parent disposal removes terminal child state", () => {
    const manager = new SubagentManager();
    injectFakeSubagent(
      manager,
      "sub-1",
      makeState("sub-1", { status: "completed" }),
      undefined,
      null, // already released
    );
    asInternals(manager).subagents.get("sub-1")!.retainedUntil =
      Date.now() + 1000;

    // Verify the terminal subagent exists.
    expect(manager.getState("sub-1")).toBeDefined();

    // Parent disposal should remove it.
    manager.disposeAllForParent("parent-sess-1");

    expect(manager.getState("sub-1")).toBeUndefined();
    expect(manager.getChildrenOf("parent-sess-1")).toHaveLength(0);
  });

  test("parent cancel keeps a completed child readable within its retention window", () => {
    const manager = new SubagentManager();
    injectFakeSubagent(
      manager,
      "sub-done",
      makeState("sub-done", { status: "completed" }),
      undefined,
      null, // conversation released, metadata retained
    );
    asInternals(manager).subagents.get("sub-done")!.retainedUntil =
      Date.now() + 60_000;

    // A user stop / idle eviction aborts in-flight children only.
    manager.abortAllForParent("parent-sess-1");

    // The completed child's result must remain resolvable by id and by label
    // so the parent can still subagent_read it after the cancel.
    expect(manager.getState("sub-done")?.status).toBe("completed");
    expect(
      manager.getByLabel("Test subagent", "parent-sess-1")?.config.id,
    ).toBe("sub-done");
    expect(manager.getChildrenOf("parent-sess-1")).toHaveLength(1);
  });

  test("TTL sweep removes expired terminal entries but not active subagents", () => {
    const manager = new SubagentManager();

    // Terminal entry with expired retention.
    injectFakeSubagent(
      manager,
      "sub-expired",
      makeState("sub-expired", { status: "completed" }),
      undefined,
      null,
    );
    asInternals(manager).subagents.get("sub-expired")!.retainedUntil =
      Date.now() - 1000; // already expired

    // Active subagent — no retainedUntil.
    injectFakeSubagent(
      manager,
      "sub-active",
      makeState("sub-active", { status: "running" }),
    );

    // Terminal but not yet expired.
    injectFakeSubagent(
      manager,
      "sub-fresh",
      makeState("sub-fresh", { status: "completed" }),
      undefined,
      null,
    );
    asInternals(manager).subagents.get("sub-fresh")!.retainedUntil =
      Date.now() + 60_000;

    asInternals(manager).sweepTerminal();

    expect(manager.getState("sub-expired")).toBeUndefined();
    expect(manager.getState("sub-active")).toBeDefined();
    expect(manager.getState("sub-fresh")).toBeDefined();

    asInternals(manager).stopSweep();
  });

  test("dispose handles already-released conversation gracefully", () => {
    const manager = new SubagentManager();
    injectFakeSubagent(
      manager,
      "sub-1",
      makeState("sub-1", { status: "completed" }),
      undefined,
      null, // conversation already released
    );

    // Should not throw.
    manager.dispose("sub-1");
    expect(manager.getState("sub-1")).toBeUndefined();
  });

  test("usage stats are preserved after conversation release", async () => {
    const manager = new SubagentManager();
    const subagentId = "sub-1";
    const state = makeState(subagentId);
    injectFakeSubagent(manager, subagentId, state);

    const managed = asInternals(manager).subagents.get(subagentId)!;
    managed.conversation!.usageStats = {
      inputTokens: 500,
      outputTokens: 200,
      estimatedCost: 0.05,
    };
    managed.conversation!.persistUserMessage = () => ({
      id: "msg-1",
      deduplicated: false,
    });
    managed.conversation!.runAgentLoop = async () => {};

    await asInternals(manager).runSubagent(subagentId, "Do something");

    expect(managed.conversation).toBeNull();
    expect(state.usage).toEqual({
      inputTokens: 500,
      outputTokens: 200,
      estimatedCost: 0.05,
    });

    asInternals(manager).stopSweep();
  });

  test("defers release when messages were enqueued during run", async () => {
    const manager = new SubagentManager();
    const subagentId = "sub-1";
    const state = makeState(subagentId);
    injectFakeSubagent(manager, subagentId, state);

    const managed = asInternals(manager).subagents.get(subagentId)!;
    managed.conversation!.persistUserMessage = () => ({
      id: "msg-1",
      deduplicated: false,
    });
    managed.conversation!.runAgentLoop = async () => {};
    // Simulate that a message was enqueued during the run.
    managed.hadEnqueuedMessages = true;

    await asInternals(manager).runSubagent(subagentId, "Do something");

    // Conversation should NOT be released — drain may still be active.
    expect(managed.conversation).not.toBeNull();
    // But retainedUntil should be set for eventual TTL cleanup.
    expect(managed.retainedUntil).toBeGreaterThan(Date.now());
    expect(state.status).toBe("completed");

    asInternals(manager).stopSweep();
  });
});

describe("durable record lifetime across disposal paths", () => {
  beforeEach(() => {
    // Idempotent; the table may already exist from a prior run.
    migrateCreateSubagentsTable();
    migrateAddSubagentParentToolUseId(getDb());
    resetTestTables("subagents");
  });

  function seedRecord(
    id: string,
    parentConversationId = "parent-sess-1",
  ): void {
    const rec: SubagentRecord = {
      id,
      parentConversationId,
      conversationId: "conv-sub-1",
      label: "Test subagent",
      objective: "Do something",
      role: "generalist",
      isFork: false,
      sendResultToUser: null,
      status: "completed",
      error: null,
      parentToolUseId: null,
      createdAt: 1000,
      startedAt: 1001,
      completedAt: 2000,
      inputTokens: 5,
      outputTokens: 7,
      estimatedCost: 0.01,
    };
    upsertSubagentRecord(rec);
  }

  test("TTL sweep frees in-memory metadata but keeps the durable row", () => {
    const manager = new SubagentManager();
    seedRecord("sub-swept");
    injectFakeSubagent(
      manager,
      "sub-swept",
      makeState("sub-swept", { status: "completed" }),
      undefined,
      null, // conversation already released
    );
    asInternals(manager).subagents.get("sub-swept")!.retainedUntil =
      Date.now() - 1000; // expired

    asInternals(manager).sweepTerminal();

    // Metadata is gone…
    expect(manager.getState("sub-swept")).toBeUndefined();
    // …but the row survives, so getSubagentDetail can still resolve the child
    // conversation for a client that missed `subagent_spawned`.
    expect(getSubagentRecordById("sub-swept")?.conversationId).toBe(
      "conv-sub-1",
    );

    asInternals(manager).stopSweep();
  });

  test("disposeAllForParent deletes the durable row", () => {
    const manager = new SubagentManager();
    seedRecord("sub-parent-gone");
    injectFakeSubagent(
      manager,
      "sub-parent-gone",
      makeState("sub-parent-gone", { status: "completed" }),
      undefined,
      null,
    );

    // The parent conversation's data is going away. the child goes with it.
    manager.disposeAllForParent("parent-sess-1");

    expect(manager.getState("sub-parent-gone")).toBeUndefined();
    expect(getSubagentRecordById("sub-parent-gone")).toBeUndefined();

    asInternals(manager).stopSweep();
  });

  test("disposeAllForParent deletes rows the sweep already evicted", () => {
    const manager = new SubagentManager();
    seedRecord("sub-swept-then-deleted");
    seedRecord("sub-other-parent", "parent-sess-2");
    injectFakeSubagent(
      manager,
      "sub-swept-then-deleted",
      makeState("sub-swept-then-deleted", { status: "completed" }),
      undefined,
      null,
    );
    asInternals(manager).subagents.get(
      "sub-swept-then-deleted",
    )!.retainedUntil = Date.now() - 1000; // expired

    // The sweep frees the in-memory entry, so `parentToChildren` no longer
    // names this child: only a by-parent delete can still reach its row.
    asInternals(manager).sweepTerminal();
    expect(getSubagentRecordById("sub-swept-then-deleted")).toBeDefined();

    manager.disposeAllForParent("parent-sess-1");

    expect(getSubagentRecordById("sub-swept-then-deleted")).toBeUndefined();
    // Another parent's rows are untouched.
    expect(getSubagentRecordById("sub-other-parent")).toBeDefined();

    asInternals(manager).stopSweep();
  });

  test("clear-all deletes rows for a parent with no live children", () => {
    const manager = new SubagentManager();
    seedRecord("sub-orphan-row", "parent-sess-3");

    // No in-memory entry at all, so `parentToChildren` holds no key for this
    // parent and iterating it would skip the row entirely.
    manager.disposeAllForAllParents();

    expect(loadAllSubagentRecords()).toHaveLength(0);
  });

  test("shutdown disposal keeps the row for rehydration", () => {
    const manager = new SubagentManager();
    seedRecord("sub-shutdown");
    injectFakeSubagent(
      manager,
      "sub-shutdown",
      makeState("sub-shutdown", { status: "running" }),
      undefined,
      null,
    );

    manager.disposeAll();

    expect(manager.getState("sub-shutdown")).toBeUndefined();
    expect(getSubagentRecordById("sub-shutdown")).toBeDefined();
  });
});

describe("SubagentManager.abort usage", () => {
  test("emits the conversation's latest usage on abort, not zeros", () => {
    const manager = new SubagentManager();
    const sent: AssistantEvent[] = [];
    const sender = (msg: AssistantEvent) => sent.push(msg);

    const subagentId = "sa-abort-usage";
    // state.usage starts at {0,0,0}; the live (fake) conversation has accrued
    // usage (makeFakeConversation → {100, 50, 0.005}). Wire `sender` as the
    // stored parent sender so `setStatus` routes the terminal event through it.
    injectFakeSubagent(manager, subagentId, makeState(subagentId), sender);

    const aborted = manager.abort(subagentId, sender, undefined, {
      suppressNotification: true,
    });
    expect(aborted).toBe(true);

    const statusMsg = sent.find(
      (m): m is Extract<AssistantEvent, { type: "subagent_status_changed" }> =>
        m.type === "subagent_status_changed",
    );
    expect(statusMsg).toBeDefined();
    expect(statusMsg!.status).toBe("aborted");
    // The emitted usage is the conversation's accrued total — NOT the {0,0,0}
    // init — so the client doesn't flush the token panel to zero on stop.
    expect(statusMsg!.usage).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      estimatedCost: 0.005,
    });

    asInternals(manager).stopSweep();
  });

  test("keeps the last-known state.usage when the conversation was already released", () => {
    const manager = new SubagentManager();
    const sent: AssistantEvent[] = [];
    const sender = (msg: AssistantEvent) => sent.push(msg);

    const subagentId = "sa-abort-no-conv";
    // No live conversation (released), but state carries a last-known usage —
    // the abort must surface that, not overwrite it.
    const state = makeState(subagentId, {
      usage: { inputTokens: 320, outputTokens: 80, estimatedCost: 0.004 },
    });
    injectFakeSubagent(manager, subagentId, state, sender, null);

    manager.abort(subagentId, sender, undefined, {
      suppressNotification: true,
    });

    const statusMsg = sent.find(
      (m): m is Extract<AssistantEvent, { type: "subagent_status_changed" }> =>
        m.type === "subagent_status_changed",
    );
    expect(statusMsg!.usage).toEqual({
      inputTokens: 320,
      outputTokens: 80,
      estimatedCost: 0.004,
    });

    asInternals(manager).stopSweep();
  });
});
