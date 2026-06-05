/**
 * Tests for AcpSessionManager.resumeFromHistory: reattaching a terminal
 * persisted session via ACP session/resume (preferred, no replay) or
 * session/load (replayed history suppressed), plus the terminal upsert
 * that lets a resumed run update its original history row.
 *
 * The agent process is replaced with a fake whose capabilities and replay
 * behavior are scripted per test; the client handler is the real
 * VellumAcpClientHandler so replay suppression is exercised end to end.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// ---------------------------------------------------------------------------
// Fake AcpAgentProcess with scriptable capabilities and history replay.
// ---------------------------------------------------------------------------

interface FakeClient {
  sessionUpdate(params: unknown): Promise<void>;
}

const fakeCaps = { loadSession: false, resume: false };
/** Chunks the fake replays through the client handler during loadSession. */
let replayChunks: string[] = [];
const fakeInstances: FakeAcpAgentProcess[] = [];

class FakeAcpAgentProcess {
  killed = false;
  spawnedCwd: string | null = null;
  loadSessionCalls: Array<{ sessionId: string; cwd: string }> = [];
  resumeSessionCalls: Array<{ sessionId: string; cwd: string }> = [];
  promptCalls: Array<{ sessionId: string; text: string }> = [];
  resolvePrompt: ((v: { stopReason: string }) => void) | null = null;

  constructor(
    public readonly agentId: string,
    public readonly config: { command: string },
    private readonly clientFactory: (agent: unknown) => FakeClient,
  ) {
    fakeInstances.push(this);
  }

  spawn(cwd: string): void {
    this.spawnedCwd = cwd;
  }

  async initialize(): Promise<void> {}

  get supportsLoadSession(): boolean {
    return fakeCaps.loadSession;
  }

  get supportsSessionResume(): boolean {
    return fakeCaps.resume;
  }

  async createSession(_cwd: string): Promise<string> {
    return "proto-new";
  }

  async loadSession(sessionId: string, cwd: string): Promise<void> {
    this.loadSessionCalls.push({ sessionId, cwd });
    // Replay history through the client handler before resolving, exactly
    // as a real agent does per the ACP spec for session/load.
    for (const text of replayChunks) {
      await this.emitChunk(text);
    }
  }

  async resumeSession(sessionId: string, cwd: string): Promise<void> {
    this.resumeSessionCalls.push({ sessionId, cwd });
  }

  /** Drives an agent_message_chunk through the real client handler. */
  async emitChunk(text: string): Promise<void> {
    await this.clientFactory(this).sessionUpdate({
      sessionId: "proto-old",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text },
      },
    });
  }

  prompt(sessionId: string, text: string): Promise<{ stopReason: string }> {
    this.promptCalls.push({ sessionId, text });
    return new Promise((res) => {
      this.resolvePrompt = res;
    });
  }

  async cancel(): Promise<void> {}

  kill(): void {
    this.killed = true;
  }
}

mock.module("../agent-process.js", () => ({
  AcpAgentProcess: FakeAcpAgentProcess,
}));

// Identity env-prep: credential-broker plumbing has its own suite.
mock.module("../prepare-agent-env.js", () => ({
  prepareAgentEnv: async (agentConfig: unknown) => agentConfig,
}));

// Resolver stub: defaults to resolving every id to the claude adapter.
type ResolveResult =
  | { ok: true; agent: { command: string; args: string[] } }
  | { ok: false; reason: "binary_not_found"; hint: string; command: string };
let resolveImpl: (id: string) => ResolveResult = () => ({
  ok: true,
  agent: { command: "claude-agent-acp", args: [] },
});
const realResolveModule = await import("../resolve-agent.js");
mock.module("../resolve-agent.js", () => ({
  ...realResolveModule,
  resolveAcpAgent: (id: string) => resolveImpl(id),
}));

import type { ServerMessage } from "../../daemon/message-protocol.js";
import type { AcpSessionUpdate } from "../../daemon/message-types/acp.js";
import { getSqlite } from "../../memory/db-connection.js";
import { initializeDb } from "../../memory/db-init.js";
import type { AcpSessionState } from "../types.js";

const { AcpSessionManager } = await import("../session-manager.js");

initializeDb();

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

function clearHistory(): void {
  getSqlite().run("DELETE FROM acp_session_history");
}

function insertHistoryRow(row: {
  id: string;
  agentId?: string;
  acpSessionId?: string;
  parentConversationId?: string;
  startedAt?: number;
  status?: string;
  cwd?: string | null;
  eventLogJson?: string;
}): void {
  getSqlite()
    .query(
      `INSERT INTO acp_session_history (
         id, agent_id, acp_session_id, parent_conversation_id,
         started_at, completed_at, status, stop_reason, error,
         event_log_json, cwd
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.id,
      row.agentId ?? "claude",
      row.acpSessionId ?? "proto-old",
      row.parentConversationId ?? "conv-1",
      row.startedAt ?? 1234,
      5678,
      row.status ?? "completed",
      "end_turn",
      null,
      row.eventLogJson ?? "[]",
      row.cwd === undefined ? "/tmp/proj" : row.cwd,
    );
}

interface HistoryRow {
  id: string;
  started_at: number;
  status: string;
  stop_reason: string | null;
  event_log_json: string;
  cwd: string | null;
}

function readHistoryRow(id: string): HistoryRow | null {
  return getSqlite()
    .query(
      `SELECT id, started_at, status, stop_reason, event_log_json, cwd
       FROM acp_session_history WHERE id = ?`,
    )
    .get(id) as HistoryRow | null;
}

function countHistoryRows(): number {
  const row = getSqlite()
    .query("SELECT COUNT(*) AS n FROM acp_session_history")
    .get() as { n: number };
  return row.n;
}

// ---------------------------------------------------------------------------
// Manager internals accessors (mirrors session-manager-persistence.test.ts)
// ---------------------------------------------------------------------------

type ManagerInternals = {
  sessions: Map<string, { clientHandler: FakeClient }>;
  eventBuffers: Map<string, Array<{ update: AcpSessionUpdate }>>;
};

function internals(
  manager: InstanceType<typeof AcpSessionManager>,
): ManagerInternals {
  return manager as unknown as ManagerInternals;
}

beforeEach(() => {
  clearHistory();
  fakeInstances.length = 0;
  fakeCaps.loadSession = false;
  fakeCaps.resume = false;
  replayChunks = [];
  resolveImpl = () => ({
    ok: true,
    agent: { command: "claude-agent-acp", args: [] },
  });
});

const PERSISTED_EVENT: AcpSessionUpdate = {
  type: "acp_session_update",
  acpSessionId: "resume-1",
  updateType: "agent_message_chunk",
  content: "original-run-chunk",
};

describe("AcpSessionManager.resumeFromHistory", () => {
  test("resumes via session/load with replay suppressed, then steers the loaded session", async () => {
    fakeCaps.loadSession = true;
    replayChunks = ["replayed-1", "replayed-2"];
    insertHistoryRow({
      id: "resume-1",
      eventLogJson: JSON.stringify([PERSISTED_EVENT]),
    });

    const manager = new AcpSessionManager(4);
    const sent: ServerMessage[] = [];
    await manager.resumeFromHistory("resume-1", (msg) => sent.push(msg));

    const fake = fakeInstances[0]!;
    expect(fake.spawnedCwd).toBe("/tmp/proj");
    expect(fake.loadSessionCalls).toEqual([
      { sessionId: "proto-old", cwd: "/tmp/proj" },
    ]);
    expect(fake.resumeSessionCalls).toEqual([]);

    // Replayed history was never forwarded to the sender; only the
    // spawned event went out.
    expect(sent.filter((m) => m.type === "acp_session_update")).toEqual([]);
    expect(sent).toEqual([
      {
        type: "acp_session_spawned",
        acpSessionId: "resume-1",
        agent: "claude",
        parentConversationId: "conv-1",
      },
    ]);

    // State reuses the row's identity and is running again.
    const state = manager.getStatus("resume-1") as AcpSessionState;
    expect(state).toMatchObject({
      id: "resume-1",
      agentId: "claude",
      acpSessionId: "proto-old",
      parentConversationId: "conv-1",
      status: "running",
      startedAt: 1234,
    });

    // Ring buffer was re-seeded from the persisted log only; the replay
    // never reached it.
    const buffer = internals(manager).eventBuffers.get("resume-1")!;
    expect(buffer.map((b) => b.update)).toEqual([PERSISTED_EVENT]);

    // Updates after the load flow normally (suppression ended).
    await fake.emitChunk("live-after-load");
    expect(sent.filter((m) => m.type === "acp_session_update")).toHaveLength(1);
    expect(internals(manager).eventBuffers.get("resume-1")).toHaveLength(2);

    // The agent receives the new prompt in the loaded session.
    await manager.steer("resume-1", "follow up please");
    expect(fake.promptCalls).toEqual([
      { sessionId: "proto-old", text: "follow up please" },
    ]);
  });

  test("prefers session/resume when advertised and never calls loadSession", async () => {
    fakeCaps.loadSession = true;
    fakeCaps.resume = true;
    insertHistoryRow({ id: "resume-2" });

    const manager = new AcpSessionManager(4);
    await manager.resumeFromHistory("resume-2", () => {});

    const fake = fakeInstances[0]!;
    expect(fake.resumeSessionCalls).toEqual([
      { sessionId: "proto-old", cwd: "/tmp/proj" },
    ]);
    expect(fake.loadSessionCalls).toEqual([]);
    const state = manager.getStatus("resume-2") as AcpSessionState;
    expect(state.status).toBe("running");
  });

  test("legacy row with null cwd raises an actionable error", async () => {
    insertHistoryRow({ id: "legacy-1", cwd: null });

    const manager = new AcpSessionManager(4);
    await expect(
      manager.resumeFromHistory("legacy-1", () => {}),
    ).rejects.toThrow(/recorded before resume support/);
    expect(fakeInstances).toHaveLength(0);
  });

  test("missing row raises the spawn-style not-found error", async () => {
    const manager = new AcpSessionManager(4);
    await expect(manager.resumeFromHistory("nope-1", () => {})).rejects.toThrow(
      'ACP session "nope-1" not found',
    );
  });

  test("row with an empty protocol session id raises an actionable error", async () => {
    insertHistoryRow({ id: "no-proto-1", acpSessionId: "" });

    const manager = new AcpSessionManager(4);
    await expect(
      manager.resumeFromHistory("no-proto-1", () => {}),
    ).rejects.toThrow(/no protocol session id/);
  });

  test("agent without either capability errors and kills the process", async () => {
    insertHistoryRow({ id: "no-caps-1" });

    const manager = new AcpSessionManager(4);
    await expect(
      manager.resumeFromHistory("no-caps-1", () => {}),
    ).rejects.toThrow('ACP agent "claude" does not support session resume');

    const fake = fakeInstances[0]!;
    expect(fake.killed).toBe(true);
    expect(internals(manager).sessions.has("no-caps-1")).toBe(false);
    expect(internals(manager).eventBuffers.has("no-caps-1")).toBe(false);
  });

  test("resolver failures surface the actionable hint", async () => {
    insertHistoryRow({ id: "no-bin-1" });
    resolveImpl = () => ({
      ok: false,
      reason: "binary_not_found",
      hint: "npm i -g @agentclientprotocol/claude-agent-acp",
      command: "claude-agent-acp",
    });

    const manager = new AcpSessionManager(4);
    await expect(
      manager.resumeFromHistory("no-bin-1", () => {}),
    ).rejects.toThrow(
      "claude-agent-acp is not on PATH. npm i -g @agentclientprotocol/claude-agent-acp",
    );
  });

  test("already-active id and concurrency limit reuse spawn's guards", async () => {
    fakeCaps.resume = true;
    insertHistoryRow({ id: "active-1" });

    const manager = new AcpSessionManager(4);
    await manager.resumeFromHistory("active-1", () => {});
    await expect(
      manager.resumeFromHistory("active-1", () => {}),
    ).rejects.toThrow('ACP session "active-1" is already active');

    const full = new AcpSessionManager(0);
    await expect(full.resumeFromHistory("active-1", () => {})).rejects.toThrow(
      /ACP concurrency limit reached \(max 0\)/,
    );
  });

  test("terminal persistence after a resumed run upserts the original row with the merged event log", async () => {
    fakeCaps.resume = true;
    insertHistoryRow({
      id: "resume-up-1",
      eventLogJson: JSON.stringify([PERSISTED_EVENT]),
    });

    const manager = new AcpSessionManager(4);
    await manager.resumeFromHistory("resume-up-1", () => {});
    await manager.steer("resume-up-1", "continue the work");

    const fake = fakeInstances[0]!;
    expect(fake.promptCalls).toEqual([
      { sessionId: "proto-old", text: "continue the work" },
    ]);

    // A new update lands during the resumed run.
    await fake.emitChunk("resumed-run-chunk");

    // Drive the prompt to completion; yield twice to flush the .then()
    // and the persist call queued behind it.
    fake.resolvePrompt!({ stopReason: "end_turn" });
    await Promise.resolve();
    await Promise.resolve();

    expect(countHistoryRows()).toBe(1);
    const row = readHistoryRow("resume-up-1")!;
    expect(row.status).toBe("completed");
    expect(row.stop_reason).toBe("end_turn");
    expect(row.started_at).toBe(1234);
    expect(row.cwd).toBe("/tmp/proj");

    const log = JSON.parse(row.event_log_json) as Array<{ content?: string }>;
    expect(log).toHaveLength(2);
    expect(log[0]!.content).toBe("original-run-chunk");
    expect(log[1]!.content).toBe("resumed-run-chunk");
  });
});
