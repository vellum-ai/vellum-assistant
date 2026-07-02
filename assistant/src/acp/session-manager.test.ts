import { afterEach, describe, expect, mock, test } from "bun:test";

import type { Conversation } from "../daemon/conversation.js";
import {
  deleteConversation,
  setConversation,
} from "../daemon/conversation-registry.js";
import { VellumAcpClientHandler } from "./client-handler.js";
import { AcpSessionManager } from "./session-manager.js";

// Parent conversations registered per test; torn down in afterEach so the
// shared registry does not leak state between cases.
const registered: string[] = [];

afterEach(() => {
  for (const id of registered.splice(0)) {
    deleteConversation(id);
  }
});

/**
 * A duck-typed parent conversation exposing only the three methods
 * `notifyParent` touches. `enqueueMessage` returns not-queued by default so the
 * persist + runAgentLoop branch runs and the metadata can be asserted; pass
 * `enqueueQueued: true` to exercise the enqueue branch instead.
 */
function mockConversation(opts?: { enqueueQueued?: boolean }) {
  const enqueueMessage = mock(() => ({
    queued: opts?.enqueueQueued ?? false,
    requestId: "req-1",
    rejected: false,
  }));
  const persistUserMessage = mock(async () => ({
    id: "msg-1",
    deduplicated: false,
  }));
  let resolveLoop!: () => void;
  const loopRan = new Promise<void>((r) => {
    resolveLoop = r;
  });
  const runAgentLoop = mock(async () => {
    resolveLoop();
  });
  const conversation = {
    enqueueMessage,
    persistUserMessage,
    runAgentLoop,
  } as unknown as Conversation;
  return {
    conversation,
    enqueueMessage,
    persistUserMessage,
    runAgentLoop,
    loopRan,
  };
}

/** Fake AcpAgentProcess covering only the calls firePromptInBackground makes. */
function fakeProcess(prompt: () => Promise<unknown>) {
  return {
    markStderr: () => 0,
    stderrSince: () => "",
    prompt,
    kill: mock(() => {}),
  };
}

/** Injects a running session directly into the manager (no child process). */
function injectSession(
  manager: AcpSessionManager,
  acpSessionId: string,
  parentConversationId: string,
  process: ReturnType<typeof fakeProcess>,
) {
  const sendToVellum = mock(() => {});
  const clientHandler = new VellumAcpClientHandler(
    acpSessionId,
    sendToVellum,
    parentConversationId,
  );
  const entry = {
    process,
    state: {
      id: acpSessionId,
      agentId: "claude",
      acpSessionId: "proto-1",
      parentConversationId,
      status: "running" as string,
      startedAt: Date.now(),
    },
    clientHandler,
    sendToVellum,
    currentPrompt: null as unknown,
    parentConversationId,
    cwd: "/tmp",
    command: "noop",
  };
  (manager as any).sessions.set(acpSessionId, entry);
  return entry;
}

function fire(
  manager: AcpSessionManager,
  acpSessionId: string,
  entry: ReturnType<typeof injectSession>,
): Promise<unknown> {
  const bg = (manager as any).firePromptInBackground(
    acpSessionId,
    entry,
    "proto-1",
    "do it",
  );
  entry.currentPrompt = bg;
  return bg;
}

describe("AcpSessionManager parent notification", () => {
  test("prompt failure notifies the parent once with the failed message + acpNotification metadata", async () => {
    const manager = new AcpSessionManager(1);
    const {
      conversation,
      enqueueMessage,
      persistUserMessage,
      runAgentLoop,
      loopRan,
    } = mockConversation();
    setConversation("parent-fail", conversation);
    registered.push("parent-fail");

    const proc = fakeProcess(() => Promise.reject(new Error("boom")));
    const entry = injectSession(manager, "sess-fail", "parent-fail", proc);

    await fire(manager, "sess-fail", entry);
    await loopRan;

    // Exactly one notification (enqueue returned not-queued, so persist+loop).
    expect(enqueueMessage).toHaveBeenCalledTimes(1);
    expect(persistUserMessage).toHaveBeenCalledTimes(1);
    expect(runAgentLoop).toHaveBeenCalledTimes(1);

    const persistArg = persistUserMessage.mock.calls[0][0] as {
      content: string;
      metadata: unknown;
    };
    expect(persistArg.content).toBe('[ACP agent "claude" failed]\n\nboom');
    expect(persistArg.metadata).toEqual({
      acpNotification: { acpSessionId: "proto-1", agent: "claude" },
    });

    // Session was torn down on failure.
    expect((manager.getStatus() as unknown[]).length).toBe(0);
    expect(proc.kill).toHaveBeenCalled();
  });

  test("prompt success still notifies the parent exactly once", async () => {
    const manager = new AcpSessionManager(1);
    const {
      conversation,
      enqueueMessage,
      persistUserMessage,
      runAgentLoop,
      loopRan,
    } = mockConversation();
    setConversation("parent-ok", conversation);
    registered.push("parent-ok");

    const proc = fakeProcess(() => Promise.resolve({ stopReason: "end_turn" }));
    const entry = injectSession(manager, "sess-ok", "parent-ok", proc);

    await fire(manager, "sess-ok", entry);
    await loopRan;

    expect(enqueueMessage).toHaveBeenCalledTimes(1);
    expect(persistUserMessage).toHaveBeenCalledTimes(1);
    expect(runAgentLoop).toHaveBeenCalledTimes(1);

    const persistArg = persistUserMessage.mock.calls[0][0] as {
      content: string;
      metadata: unknown;
    };
    expect(
      persistArg.content.startsWith('[ACP agent "claude" completed]'),
    ).toBe(true);
    expect(persistArg.metadata).toEqual({
      acpNotification: { acpSessionId: "proto-1", agent: "claude" },
    });
  });

  test("a cancelled session does not notify the parent on failure", async () => {
    const manager = new AcpSessionManager(1);
    const { conversation, enqueueMessage } = mockConversation();
    setConversation("parent-cancel", conversation);
    registered.push("parent-cancel");

    const proc = fakeProcess(() => Promise.reject(new Error("boom")));
    const entry = injectSession(manager, "sess-cancel", "parent-cancel", proc);
    // Simulate a user cancel landing before the rejection settles.
    entry.state.status = "cancelled";

    await fire(manager, "sess-cancel", entry);
    // Any notification would have called enqueue synchronously inside the catch.
    expect(enqueueMessage).not.toHaveBeenCalled();
    // Nor a terminal error event (would regress the optimistic Cancelled state).
    const sentTypes = (entry.sendToVellum.mock.calls as unknown[][]).map(
      (c) => (c[0] as { type?: string })?.type,
    );
    expect(sentTypes).not.toContain("acp_session_error");
  });

  test("a cancelled session does not notify the parent on success", async () => {
    // A prompt can win the cancel race by resolving normally; a user stop must
    // still not wake the parent with a completion.
    const manager = new AcpSessionManager(1);
    const { conversation, enqueueMessage } = mockConversation();
    setConversation("parent-cancel-ok", conversation);
    registered.push("parent-cancel-ok");

    const proc = fakeProcess(() => Promise.resolve({ stopReason: "end_turn" }));
    const entry = injectSession(
      manager,
      "sess-cancel-ok",
      "parent-cancel-ok",
      proc,
    );
    entry.state.status = "cancelled";

    await fire(manager, "sess-cancel-ok", entry);
    expect(enqueueMessage).not.toHaveBeenCalled();
    // Nor a completed terminal event: it would regress the client's optimistic
    // Cancelled state to Completed while history is stored as cancelled.
    const sentTypes = (entry.sendToVellum.mock.calls as unknown[][]).map(
      (c) => (c[0] as { type?: string })?.type,
    );
    expect(sentTypes).not.toContain("acp_session_completed");
  });

  test("cancel marks the session cancelled before the protocol cancel resolves", async () => {
    // Guards the cancel race: if the in-flight prompt rejects while
    // process.cancel is still pending, the failure gate must already see
    // "cancelled" so it does not wake the parent after a user stop.
    const manager = new AcpSessionManager(1);
    let resolveCancel!: () => void;
    const cancelPending = new Promise<void>((r) => {
      resolveCancel = r;
    });
    const proc = {
      markStderr: () => 0,
      stderrSince: () => "",
      prompt: () => new Promise(() => {}),
      kill: mock(() => {}),
      cancel: mock(() => cancelPending),
    };
    const entry = injectSession(
      manager,
      "sess-race",
      "parent-race",
      proc as unknown as ReturnType<typeof fakeProcess>,
    );

    const cancelPromise = (manager as any).cancel("sess-race");
    // Synchronously after kicking off cancel — before the protocol cancel
    // resolves — the status is already "cancelled".
    expect(entry.state.status).toBe("cancelled");
    expect(proc.cancel).toHaveBeenCalled();

    resolveCancel();
    await cancelPromise;
  });

  test("a superseded prompt does not notify the parent", async () => {
    const manager = new AcpSessionManager(1);
    const { conversation, enqueueMessage } = mockConversation();
    setConversation("parent-stale", conversation);
    registered.push("parent-stale");

    const proc = fakeProcess(() => Promise.reject(new Error("boom")));
    const entry = injectSession(manager, "sess-stale", "parent-stale", proc);

    const bg = (manager as any).firePromptInBackground(
      entry.state.id,
      entry,
      "proto-1",
      "do it",
    );
    // A concurrent steer superseded this prompt: currentPrompt no longer
    // points at it, so the whole catch body (including notify) is skipped.
    entry.currentPrompt = null;
    await bg;

    expect(enqueueMessage).not.toHaveBeenCalled();
    // The stale catch left the session in place (no teardown).
    expect((manager.getStatus() as unknown[]).length).toBe(1);
  });
});
