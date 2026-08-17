import { afterEach, describe, expect, mock, test } from "bun:test";

import type { Conversation } from "../daemon/conversation.js";
import {
  deleteConversation,
  setConversation,
} from "../daemon/conversation-registry.js";
import { hasAcpConnectCardRaised } from "./acp-connect-card-state.js";
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

    const persistArg = (
      persistUserMessage.mock.calls as unknown as Array<
        [{ content: string; metadata: unknown }]
      >
    )[0][0];
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

    const persistArg = (
      persistUserMessage.mock.calls as unknown as Array<
        [{ content: string; metadata: unknown }]
      >
    )[0][0];
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

  test("cancel restores the previous status when the protocol cancel throws", async () => {
    // If process.cancel rejects, the session was not actually cancelled, so the
    // status must roll back to running (else the live prompt's eventual settle
    // is wrongly suppressed) and the error must propagate to the caller.
    const manager = new AcpSessionManager(1);
    const proc = {
      markStderr: () => 0,
      stderrSince: () => "",
      prompt: () => new Promise(() => {}),
      kill: mock(() => {}),
      cancel: mock(() => Promise.reject(new Error("adapter down"))),
    };
    const entry = injectSession(
      manager,
      "sess-cancel-throw",
      "parent-cancel-throw",
      proc as unknown as ReturnType<typeof fakeProcess>,
    );
    // A prompt is still in flight; cancel must not tear it down on failure.
    entry.currentPrompt = new Promise(() => {});

    await expect((manager as any).cancel("sess-cancel-throw")).rejects.toThrow(
      "adapter down",
    );
    expect(entry.state.status).toBe("running");
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

// ---------------------------------------------------------------------------
// Auth-required recovery surface
// ---------------------------------------------------------------------------

describe("AcpSessionManager auth-required recovery surface", () => {
  /** The live-captured shape of a rejected-credential failure. */
  const authFailure = () =>
    Promise.reject(
      new Error(
        "Internal error: Failed to authenticate. API Error: 401 OAuth access token has been revoked.",
      ),
    );

  /** Drives an auth-shaped prompt failure through firePromptInBackground. */
  async function driveAuthFailure(opts: {
    id: string;
    command: string;
    parentToolUseId?: string;
    cancelled?: boolean;
  }) {
    const manager = new AcpSessionManager(1);
    const parentId = `parent-${opts.id}`;
    const { conversation, persistUserMessage, loopRan } = mockConversation();
    setConversation(parentId, conversation);
    registered.push(parentId);

    const entry = injectSession(
      manager,
      opts.id,
      parentId,
      fakeProcess(authFailure),
    );
    entry.command = opts.command;
    (entry as { parentToolUseId?: string }).parentToolUseId =
      opts.parentToolUseId;
    if (opts.cancelled) {
      entry.state.status = "cancelled";
    }

    await fire(manager, opts.id, entry).catch(() => {});
    if (!opts.cancelled) {
      await loopRan;
    }

    const events = (
      entry.sendToVellum as ReturnType<typeof mock>
    ).mock.calls.map((c) => c[0] as { type: string } & Record<string, unknown>);
    const firstPersist = persistUserMessage.mock.calls[0] as unknown as
      | [{ content: string }]
      | undefined;
    return {
      parentId,
      authEvent: events.find((e) => e.type === "acp_auth_required"),
      persistedContent: firstPersist?.[0].content,
    };
  }

  test("claude failure with an anchor raises the full surface: event, registry mark, guidance", async () => {
    const r = await driveAuthFailure({
      id: "sess-auth-anchor",
      command: "claude-agent-acp",
      parentToolUseId: "tool-anchor-1",
    });

    expect(r.authEvent).toMatchObject({
      acpSessionId: "sess-auth-anchor",
      authCode: "acp_claude_auth_required",
      agent: "claude",
      parentToolUseId: "tool-anchor-1",
    });
    // The credential-prompt route consults this registry to redirect a
    // redundant secure prompt at the card instead of stacking a second one.
    expect(hasAcpConnectCardRaised(r.parentId)).toBe(true);
    expect(r.persistedContent).toContain("Connect Claude Code");
  });

  test("claude failure without an anchor keeps the plain failure: no event, no mark, no guidance", async () => {
    // No spawning tool call means no transcript row to render the card under;
    // guidance would point the model at a card that cannot appear.
    const r = await driveAuthFailure({
      id: "sess-auth-noanchor",
      command: "claude-agent-acp",
    });

    expect(r.authEvent).toBeUndefined();
    expect(hasAcpConnectCardRaised(r.parentId)).toBe(false);
    expect(r.persistedContent).not.toContain("Connect Claude Code");
  });

  test("a run the user already stopped raises nothing: no event, no registry mark, no parent turn", async () => {
    // The client never renders a card for a cancelled run, and the
    // prompt-dedup registry is never cleared, so marking it here would
    // suppress the secure token prompt for the daemon's lifetime against a
    // card that does not exist.
    const r = await driveAuthFailure({
      id: "sess-auth-cancelled",
      command: "claude-agent-acp",
      parentToolUseId: "tool-anchor-3",
      cancelled: true,
    });

    expect(r.authEvent).toBeUndefined();
    expect(hasAcpConnectCardRaised(r.parentId)).toBe(false);
    expect(r.persistedContent).toBeUndefined();
  });

  test("a non-claude adapter never raises the surface, even on an auth-shaped failure", async () => {
    const r = await driveAuthFailure({
      id: "sess-auth-codex",
      command: "codex-acp",
      parentToolUseId: "tool-anchor-2",
    });

    expect(r.authEvent).toBeUndefined();
    expect(hasAcpConnectCardRaised(r.parentId)).toBe(false);
  });
});
