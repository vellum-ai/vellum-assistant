/**
 * Tests for AcpSessionManager's keep-alive idle lifecycle (PR E1):
 *
 * - After a prompt completes the session stays alive in `idle` status with
 *   its process intact (it is NOT torn down), while a terminal `completed`
 *   row is still persisted to `acp_session_history`.
 * - An idle session is reusable: `steer()` runs a follow-up prompt on the
 *   same process and resets per-turn streaming state.
 * - The idle-timeout reaper reclaims an idle session (process killed, slot
 *   freed) once the timeout elapses, without re-persisting history.
 * - `getLiveSessionForConversation` finds the live (running/idle) session for
 *   a conversation so follow-ups (PR E2) can reattach.
 *
 * Like session-manager-persistence.test.ts, these inject a fake
 * AcpAgentProcess directly into the session map to drive prompt
 * completion/timing deterministically without spawning a child process.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import { VellumAcpClientHandler } from "../../acp/client-handler.js";
import { AcpSessionManager } from "../../acp/session-manager.js";
import type { ServerMessage } from "../../daemon/message-protocol.js";
import { getSqlite } from "../../memory/db-connection.js";
import { initializeDb } from "../../memory/db-init.js";
initializeDb();

function clearHistory() {
  getSqlite().run("DELETE FROM acp_session_history");
}

function readStatus(id: string): string | null {
  const row = getSqlite()
    .query("SELECT status FROM acp_session_history WHERE id = ?")
    .get(id) as { status: string } | null;
  return row?.status ?? null;
}

/** All history rows whose id is `<base>` or `<base>:<turn>`, ordered by id. */
function readTurnRows(
  base: string,
): { id: string; status: string; stopReason: string | null }[] {
  return getSqlite()
    .query(
      "SELECT id, status, stop_reason AS stopReason FROM acp_session_history " +
        "WHERE id = ? OR id LIKE ? ORDER BY id",
    )
    .all(base, `${base}:%`) as {
    id: string;
    status: string;
    stopReason: string | null;
  }[];
}

interface FakeProcess {
  prompt: (sessionId: string, text: string) => Promise<{ stopReason: string }>;
  kill: () => void;
  cancel: () => Promise<void>;
  killed: boolean;
  promptCalls: string[];
}

/**
 * Injects a fake session into the manager map (matching spawn()'s wiring) and
 * fires its first prompt. The returned `resolvePrompt` drives the prompt to
 * completion. `idleTimeoutMs` lets callers exercise the reaper.
 */
function buildIdleSession(opts: {
  id: string;
  parentConversationId: string;
  idleTimeoutMs?: number;
}): {
  manager: AcpSessionManager;
  fakeProcess: FakeProcess;
  resolvePrompt: (v: { stopReason: string }) => void;
  sent: ServerMessage[];
} {
  const manager = new AcpSessionManager(4, opts.idleTimeoutMs ?? 60_000);
  const sent: ServerMessage[] = [];
  const sendToVellum = (msg: ServerMessage) => sent.push(msg);

  // Each prompt() call gets a fresh, independently-resolvable promise so a
  // follow-up steer() doesn't inherit the first turn's already-resolved one.
  let resolvePrompt!: (v: { stopReason: string }) => void;

  const fakeProcess: FakeProcess = {
    promptCalls: [],
    killed: false,
    prompt(_sessionId: string, text: string) {
      this.promptCalls.push(text);
      return new Promise<{ stopReason: string }>((res) => {
        resolvePrompt = res;
      });
    },
    kill() {
      this.killed = true;
    },
    cancel: () => Promise.resolve(),
  };

  const sessions = (manager as unknown as { sessions: Map<string, unknown> })
    .sessions;
  const eventBuffers = (
    manager as unknown as { eventBuffers: Map<string, unknown[]> }
  ).eventBuffers;
  eventBuffers.set(opts.id, []);

  const clientHandler = new VellumAcpClientHandler(
    opts.id,
    sendToVellum,
    opts.parentConversationId,
  );

  const entry = {
    process: fakeProcess,
    state: {
      id: opts.id,
      agentId: "agent-X",
      acpSessionId: "proto-X",
      parentConversationId: opts.parentConversationId,
      status: "running",
      startedAt: Date.now(),
    },
    clientHandler,
    sendToVellum,
    currentPrompt: null as Promise<unknown> | null,
    parentConversationId: opts.parentConversationId,
    cwd: "/tmp",
    command: "codex-acp",
    idleTimer: null,
    historyPersisted: false,
    turnIndex: 0,
  };
  sessions.set(opts.id, entry);

  entry.currentPrompt = (
    manager as unknown as {
      firePromptInBackground: (
        id: string,
        e: typeof entry,
        protoId: string,
        msg: string,
      ) => Promise<unknown>;
    }
  ).firePromptInBackground(opts.id, entry, "proto-X", "do work");

  // `resolvePrompt` always resolves the most recent prompt() promise — the
  // fake reassigns it on every call, so steer() reuse can be driven too.
  return {
    manager,
    fakeProcess,
    resolvePrompt: (v: { stopReason: string }) => resolvePrompt(v),
    sent,
  };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("AcpSessionManager — idle keep-alive lifecycle", () => {
  beforeEach(() => {
    clearHistory();
  });

  test("a completed prompt leaves the session idle and alive, with a persisted 'completed' row", async () => {
    const id = "idle-1";
    const { manager, fakeProcess, resolvePrompt } = buildIdleSession({
      id,
      parentConversationId: "conv-idle-1",
    });

    resolvePrompt({ stopReason: "end_turn" });
    await flush();

    // In-memory: status idle, process NOT killed, still in the map.
    const state = manager.getStatus(id) as { status: string };
    expect(state.status).toBe("idle");
    expect(fakeProcess.killed).toBe(false);

    // History: a terminal 'completed' row was written.
    expect(readStatus(id)).toBe("completed");
  });

  test("getLiveSessionForConversation finds the idle session for its conversation", async () => {
    const id = "idle-2";
    const { manager, resolvePrompt } = buildIdleSession({
      id,
      parentConversationId: "conv-idle-2",
    });

    resolvePrompt({ stopReason: "end_turn" });
    await flush();

    const live = manager.getLiveSessionForConversation("conv-idle-2");
    expect(live).not.toBeNull();
    expect(live!.id).toBe(id);
    expect(live!.status).toBe("idle");

    expect(manager.getLiveSessionForConversation("nope")).toBeNull();
  });

  test("steer() reuses an idle session — same process, status back to running", async () => {
    const id = "idle-3";
    const { manager, fakeProcess, resolvePrompt } = buildIdleSession({
      id,
      parentConversationId: "conv-idle-3",
    });

    resolvePrompt({ stopReason: "end_turn" });
    await flush();
    expect((manager.getStatus(id) as { status: string }).status).toBe("idle");

    await manager.steer(id, "now change Y");

    // Same process reused (not killed); a second prompt was sent.
    expect(fakeProcess.killed).toBe(false);
    expect(fakeProcess.promptCalls).toEqual(["do work", "now change Y"]);
    expect((manager.getStatus(id) as { status: string }).status).toBe(
      "running",
    );
  });

  test("idle-timeout reaper closes the session (process killed, slot freed)", async () => {
    const id = "idle-4";
    const { manager, fakeProcess, resolvePrompt } = buildIdleSession({
      id,
      parentConversationId: "conv-idle-4",
      idleTimeoutMs: 10,
    });

    resolvePrompt({ stopReason: "end_turn" });
    await flush();
    expect((manager.getStatus(id) as { status: string }).status).toBe("idle");

    // Wait for the 10ms idle reaper to fire.
    await new Promise((r) => setTimeout(r, 40));

    expect(fakeProcess.killed).toBe(true);
    // Session removed from the map.
    expect(() => manager.getStatus(id)).toThrow();
    // History row remains 'completed' — the reaper did not clobber it.
    expect(readStatus(id)).toBe("completed");
  });

  test("explicit close() of an idle session tears it down without re-persisting", async () => {
    const id = "idle-5";
    const { manager, fakeProcess, resolvePrompt } = buildIdleSession({
      id,
      parentConversationId: "conv-idle-5",
    });

    resolvePrompt({ stopReason: "end_turn" });
    await flush();

    manager.close(id);

    expect(fakeProcess.killed).toBe(true);
    expect(() => manager.getStatus(id)).toThrow();
    // Row still 'completed' (not overwritten to 'cancelled').
    expect(readStatus(id)).toBe("completed");
  });

  test("a reused (steered) idle session's second turn is persisted to its own history row", async () => {
    const id = "idle-6";
    const { manager, resolvePrompt } = buildIdleSession({
      id,
      parentConversationId: "conv-idle-6",
    });

    // Turn 0 completes → persisted under the bare id.
    resolvePrompt({ stopReason: "end_turn" });
    await flush();
    expect((manager.getStatus(id) as { status: string }).status).toBe("idle");

    // Reuse the idle session for a second turn, then complete it.
    await manager.steer(id, "now do more");
    resolvePrompt({ stopReason: "max_tokens" });
    await flush();

    // Both turns are durably recorded as distinct rows — the second turn was
    // NOT silently dropped by onConflictDoNothing against the first turn's id.
    const rows = readTurnRows(id);
    expect(rows.map((r) => r.id)).toEqual([id, `${id}:1`]);
    expect(rows.map((r) => r.status)).toEqual(["completed", "completed"]);
    // Each row carries its own turn's stop reason.
    expect(rows[0]!.stopReason).toBe("end_turn");
    expect(rows[1]!.stopReason).toBe("max_tokens");
  });

  test("cancel() of an idle session tears it down (process killed, slot + timer freed)", async () => {
    const id = "idle-7";
    const { manager, fakeProcess, resolvePrompt } = buildIdleSession({
      id,
      // Small timeout so a leaked timer would be observable; teardown must
      // clear it.
      idleTimeoutMs: 10,
      parentConversationId: "conv-idle-7",
    });

    resolvePrompt({ stopReason: "end_turn" });
    await flush();
    expect((manager.getStatus(id) as { status: string }).status).toBe("idle");

    // The idle session has no in-flight prompt — cancel must drive teardown
    // directly rather than wait on a catch handler that will never fire.
    await manager.cancel(id);

    // Process killed, session removed from the map.
    expect(fakeProcess.killed).toBe(true);
    expect(() => manager.getStatus(id)).toThrow();

    // The idle timer was cleared: even after the timeout elapses, the reaper
    // does not run against a dangling entry (no throw, state unchanged).
    await new Promise((r) => setTimeout(r, 40));
    expect(() => manager.getStatus(id)).toThrow();

    // Completed history row was not clobbered to 'cancelled'.
    expect(readStatus(id)).toBe("completed");
  });
});
