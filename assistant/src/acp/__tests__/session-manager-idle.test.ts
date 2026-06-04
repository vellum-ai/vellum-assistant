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

/**
 * Registry of the most recent fake AcpAgentProcess per spawning manager, keyed
 * by the cwd passed to spawn() (the concurrency tests use a distinct cwd per
 * session so each spawned fake is individually addressable). Each fake exposes
 * a `resolvePrompt` to drive its prompt to completion (→ idle) and a `killed`
 * flag to assert teardown. Registered process-globally via mock.module before
 * session-manager.js is imported, so spawn()'s `new AcpAgentProcess` resolves
 * to this fake.
 */
const spawnedFakes: FakeSpawnedProcess[] = [];

interface FakeSpawnedProcess {
  cwd: string;
  killed: boolean;
  resolvePrompt: (v: { stopReason: string }) => void;
}

mock.module("../agent-process.js", () => ({
  AcpAgentProcess: class FakeAcpAgentProcess {
    private record: FakeSpawnedProcess = {
      cwd: "",
      killed: false,
      resolvePrompt: () => {},
    };
    constructor(
      public readonly agentId: string,
      _config: unknown,
      _factory: unknown,
    ) {}
    spawn(cwd: string): void {
      this.record.cwd = cwd;
      spawnedFakes.push(this.record);
    }
    async initialize(): Promise<void> {}
    async createSession(_cwd: string): Promise<string> {
      return `proto-${this.agentId}`;
    }
    prompt(): Promise<{ stopReason: string }> {
      return new Promise((res) => {
        this.record.resolvePrompt = res;
      });
    }
    async cancel(): Promise<void> {}
    kill(): void {
      this.record.killed = true;
    }
  },
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

/** Started-at timestamp for a persisted turn row (`<base>` or `<base>:<turn>`). */
function readStartedAt(id: string): number | null {
  const row = getSqlite()
    .query("SELECT started_at AS startedAt FROM acp_session_history WHERE id = ?")
    .get(id) as { startedAt: number } | null;
  return row?.startedAt ?? null;
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

  test("steer() on an idle session broadcasts acp_session_resumed so clients flip back to running", async () => {
    const id = "idle-resumed";
    const { manager, resolvePrompt, sent } = buildIdleSession({
      id,
      parentConversationId: "conv-idle-resumed",
    });

    // Drive turn 0 to completion → idle. The completion broadcasts
    // `acp_session_completed`, after which clients show the session finished.
    resolvePrompt({ stopReason: "end_turn" });
    await flush();
    expect((manager.getStatus(id) as { status: string }).status).toBe("idle");

    const before = sent.length;
    await manager.steer(id, "now change Y");

    // Reuse broadcasts exactly one `acp_session_resumed` carrying the session
    // id — the signal clients use to flip the existing session back to running
    // instead of leaving it looking finished while the follow-up turn runs.
    const resumed = sent
      .slice(before)
      .filter((m) => m.type === "acp_session_resumed");
    expect(resumed).toEqual([{ type: "acp_session_resumed", acpSessionId: id }]);
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

  test("a reused turn persists the turn's start time, not the original spawn time", async () => {
    const id = "idle-startedat";
    const { manager, resolvePrompt } = buildIdleSession({
      id,
      parentConversationId: "conv-startedat",
    });

    // Drive turn 0 to completion → persisted under the bare id with the
    // original startedAt.
    resolvePrompt({ stopReason: "end_turn" });
    await flush();

    const entry = (
      manager as unknown as {
        sessions: Map<string, { state: { startedAt: number } }>;
      }
    ).sessions.get(id)!;
    const originalStartedAt = entry.state.startedAt;

    // Make the reused turn unambiguously later than the original spawn time so
    // the assertion can't pass on a same-millisecond tie.
    await new Promise((r) => setTimeout(r, 5));
    await manager.steer(id, "second turn");
    resolvePrompt({ stopReason: "end_turn" });
    await flush();

    // Turn 0's row keeps the original spawn time.
    expect(readStartedAt(id)).toBe(originalStartedAt);
    // The reused turn's row carries the turn's OWN (newer) start time, not the
    // stale original — so `/acp/sessions` ordering reflects when it ran.
    const turn1StartedAt = readStartedAt(`${id}:1`)!;
    expect(turn1StartedAt).toBeGreaterThan(originalStartedAt);
  });

  test("getLiveSessionForConversation prefers the just-reused session over a newer-started one", async () => {
    const conv = "conv-reuse-recency";
    // Session A: started first, then reused (steered) so it is the most
    // recently *active* session for the conversation.
    const a = buildIdleSession({ id: "reuse-A", parentConversationId: conv });
    a.resolvePrompt({ stopReason: "end_turn" });
    await flush();

    // Inject session B into the SAME manager + conversation, started LATER than
    // A but never reused — so it has a newer startedAt but an older
    // lastActiveAt once A is steered.
    const sessions = (
      a.manager as unknown as { sessions: Map<string, unknown> }
    ).sessions;
    const eventBuffers = (
      a.manager as unknown as { eventBuffers: Map<string, unknown[]> }
    ).eventBuffers;
    eventBuffers.set("reuse-B", []);
    sessions.set("reuse-B", {
      process: { kill() {}, cancel: () => Promise.resolve() },
      state: {
        id: "reuse-B",
        agentId: "agent-X",
        acpSessionId: "proto-B",
        parentConversationId: conv,
        status: "idle",
        startedAt: 5_000,
      },
      clientHandler: new VellumAcpClientHandler("reuse-B", () => {}, conv),
      sendToVellum: () => {},
      currentPrompt: null,
      parentConversationId: conv,
      cwd: "/tmp",
      command: "codex-acp",
      idleTimer: null,
      lastActiveAt: 5_000,
      historyPersisted: true,
      turnIndex: 0,
    });

    // Reuse A (newer activity) while B sits idle. steer() refreshes A's
    // lastActiveAt to now — later than B's 5_000 — so A wins "most recent".
    await a.manager.steer("reuse-A", "follow-up");
    const live = a.manager.getLiveSessionForConversation(conv);
    expect(live).not.toBeNull();
    expect(live!.id).toBe("reuse-A");
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

describe("AcpSessionManager — idle sessions don't wedge the spawn limit", () => {
  const noopSend = () => {};

  beforeEach(() => {
    clearHistory();
    spawnedFakes.length = 0;
  });

  /** Spawns a session in `manager` at a unique cwd; returns id + its fake. */
  async function spawnSession(
    manager: AcpSessionManager,
    cwd: string,
  ): Promise<{ id: string; fake: FakeSpawnedProcess }> {
    const before = spawnedFakes.length;
    const { acpSessionId } = await manager.spawn(
      "agent-X",
      { command: "codex-acp", args: [] },
      "do work",
      cwd,
      `conv-${cwd}`,
      noopSend,
    );
    const fake = spawnedFakes[before]!;
    return { id: acpSessionId, fake };
  }

  test("N completed→idle sessions do NOT block an (N+1)th spawn — oldest idle is reaped", async () => {
    const max = 3;
    const manager = new AcpSessionManager(max, 60_000);

    // Fill the budget with `max` sessions and drive each to idle.
    const sessions: { id: string; fake: FakeSpawnedProcess }[] = [];
    for (let i = 0; i < max; i++) {
      const s = await spawnSession(manager, `/cwd-${i}`);
      s.fake.resolvePrompt({ stopReason: "end_turn" });
      await flush();
      expect((manager.getStatus(s.id) as { status: string }).status).toBe(
        "idle",
      );
      sessions.push(s);
    }

    // Map is full and at the limit.
    expect((manager.getStatus() as unknown[]).length).toBe(max);

    // The (N+1)th spawn must succeed by reaping the OLDEST idle session.
    const extra = await spawnSession(manager, "/cwd-new");
    expect(extra.id).toBeTruthy();

    // Oldest idle (the first one started) was torn down: process killed and
    // removed from the map.
    expect(sessions[0]!.fake.killed).toBe(true);
    expect(() => manager.getStatus(sessions[0]!.id)).toThrow();

    // Newer idle sessions are untouched and the new one is tracked.
    expect(sessions[1]!.fake.killed).toBe(false);
    expect(sessions[2]!.fake.killed).toBe(false);
    expect((manager.getStatus(extra.id) as { status: string }).status).toBe(
      "running",
    );

    // Still at the limit (one reaped, one added), no leak above max.
    expect((manager.getStatus() as unknown[]).length).toBe(max);

    // The reaped session's completed history row was not clobbered.
    expect(readStatus(sessions[0]!.id)).toBe("completed");
  });

  test("eviction reaps the LONGEST-idle session, not the oldest-started — a just-reused session is spared", async () => {
    const max = 3;
    const manager = new AcpSessionManager(max, 60_000);

    // Fill the budget; drive each to idle. `sessions[0]` started first (oldest
    // startedAt), `sessions[2]` started last.
    const sessions: { id: string; fake: FakeSpawnedProcess }[] = [];
    for (let i = 0; i < max; i++) {
      const s = await spawnSession(manager, `/cwd-${i}`);
      s.fake.resolvePrompt({ stopReason: "end_turn" });
      await flush();
      sessions.push(s);
    }

    // Reuse the OLDEST-started session (sessions[0]) via steer, then drive it
    // back to idle. steer() refreshes its `lastActiveAt`, so although it has
    // the oldest startedAt it is now the MOST-recently-active idle session.
    await manager.steer(sessions[0]!.id, "follow-up turn");
    expect((manager.getStatus(sessions[0]!.id) as { status: string }).status)
      .toBe("running");
    sessions[0]!.fake.resolvePrompt({ stopReason: "end_turn" });
    await flush();
    expect((manager.getStatus(sessions[0]!.id) as { status: string }).status)
      .toBe("idle");

    // Make the relative idle ordering deterministic regardless of wall-clock
    // resolution: sessions[1] has been idle the LONGEST, sessions[0] (just
    // reused) the shortest. Stamp `lastActiveAt` directly on the entries.
    const sessionMap = (
      manager as unknown as {
        sessions: Map<string, { lastActiveAt: number }>;
      }
    ).sessions;
    sessionMap.get(sessions[1]!.id)!.lastActiveAt = 1_000;
    sessionMap.get(sessions[2]!.id)!.lastActiveAt = 2_000;
    sessionMap.get(sessions[0]!.id)!.lastActiveAt = 3_000;

    // The (N+1)th spawn must reap the LONGEST-idle session (sessions[1]),
    // NOT the oldest-started one (sessions[0], which was just reused).
    const extra = await spawnSession(manager, "/cwd-new");
    expect(extra.id).toBeTruthy();

    expect(sessions[1]!.fake.killed).toBe(true);
    expect(() => manager.getStatus(sessions[1]!.id)).toThrow();

    // The just-reused oldest-started session and the other idle one survive.
    expect(sessions[0]!.fake.killed).toBe(false);
    expect(sessions[2]!.fake.killed).toBe(false);
    expect((manager.getStatus(sessions[0]!.id) as { status: string }).status)
      .toBe("idle");

    expect((manager.getStatus() as unknown[]).length).toBe(max);
  });

  test("a genuinely RUNNING session still counts toward the limit (no idle to reap → reject)", async () => {
    const max = 2;
    const manager = new AcpSessionManager(max, 60_000);

    // Two running sessions (prompts never resolved → stay `running`).
    const a = await spawnSession(manager, "/run-a");
    const b = await spawnSession(manager, "/run-b");
    expect((manager.getStatus(a.id) as { status: string }).status).toBe(
      "running",
    );
    expect((manager.getStatus(b.id) as { status: string }).status).toBe(
      "running",
    );

    // No idle session to reap — the third spawn must reject.
    await expect(spawnSession(manager, "/run-c")).rejects.toThrow(
      /concurrency limit reached/,
    );

    // Neither running session was torn down by the failed spawn.
    expect(a.fake.killed).toBe(false);
    expect(b.fake.killed).toBe(false);
    expect((manager.getStatus() as unknown[]).length).toBe(max);
  });

  test("reaping the oldest idle session clears its idle timer (no leaked reaper)", async () => {
    const max = 1;
    // Tiny idle timeout: if the reaped session's timer leaked, it would fire
    // against a dangling entry after teardown. The reaper guards against that,
    // but clearing the timer on teardown is the real fix under test.
    const manager = new AcpSessionManager(max, 10);

    const first = await spawnSession(manager, "/timer-a");
    first.fake.resolvePrompt({ stopReason: "end_turn" });
    await flush();
    expect((manager.getStatus(first.id) as { status: string }).status).toBe(
      "idle",
    );

    // Second spawn reaps the single idle session to free the only slot.
    const second = await spawnSession(manager, "/timer-b");
    expect(first.fake.killed).toBe(true);
    expect(() => manager.getStatus(first.id)).toThrow();

    // Let the would-be idle timer interval elapse: the reaped session's timer
    // must NOT fire and disturb the new session.
    await new Promise((r) => setTimeout(r, 40));
    expect((manager.getStatus(second.id) as { status: string }).status).toBe(
      "running",
    );
    expect(second.fake.killed).toBe(false);
  });
});
