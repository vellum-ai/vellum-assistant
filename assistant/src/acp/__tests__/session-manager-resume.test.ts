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
/** When set, prompt() throws synchronously (steerOrResume teardown tests). */
let promptThrowsSync = false;
/**
 * When set, resumeSession() stalls on this gate. Lets tests observe the
 * post-registration "initializing" window where the SessionEntry exists but
 * the resume has not yet settled.
 */
let resumeSessionGate: Promise<void> | null = null;
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
    public readonly config: {
      command: string;
      args: string[];
    },
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
    if (resumeSessionGate) await resumeSessionGate;
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
    if (promptThrowsSync) {
      throw new Error("prompt transport dead");
    }
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

// Identity env-prep: credential-broker plumbing has its own suite. Tests
// that need to observe the manager mid-resume (dispose, pending-id
// visibility) set `prepareAgentEnvGate` to stall the resume here.
let prepareAgentEnvGate: Promise<void> | null = null;
mock.module("../prepare-agent-env.js", () => ({
  prepareAgentEnv: async (agentConfig: unknown) => {
    if (prepareAgentEnvGate) await prepareAgentEnvGate;
    return agentConfig;
  },
}));

// Resolver stub: defaults to resolving every id to the claude adapter.
type ResolveResult =
  | {
      ok: true;
      agent: { command: string; args: string[] };
    }
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
import {
  clearHistory,
  insertHistoryRow,
  readHistoryRow,
} from "./helpers/acp-history-db.js";

const { AcpResumeError, AcpSessionManager, AcpSessionNotFoundError } =
  await import("../session-manager.js");

initializeDb();

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
  sessions: Map<string, { clientHandler: FakeClient; command: string }>;
  eventBuffers: Map<string, Array<{ update: AcpSessionUpdate }>>;
  pendingResumes: Map<string, Promise<void>>;
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
  promptThrowsSync = false;
  prepareAgentEnvGate = null;
  resumeSessionGate = null;
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

  test("re-resolves via resolveAcpAgent: the installed real binary flows through resume", async () => {
    // resumeFromHistory re-resolves through resolveAcpAgent, so the one-time
    // sandboxed install performed at spawn time benefits resume too: the
    // resolver now returns the real installed binary (a full path here), and
    // the SessionEntry tracks its basename for resume-hint gating.
    fakeCaps.resume = true;
    insertHistoryRow({ id: "installed-resume-1" });
    resolveImpl = () => ({
      ok: true,
      agent: {
        command: "/usr/local/bin/claude-agent-acp",
        args: [],
      },
    });

    const manager = new AcpSessionManager(4);
    await manager.resumeFromHistory("installed-resume-1", () => {});

    const fake = fakeInstances[0]!;
    expect(fake.config.command).toBe("/usr/local/bin/claude-agent-acp");
    expect(fake.resumeSessionCalls).toEqual([
      { sessionId: "proto-old", cwd: "/tmp/proj" },
    ]);
    // The SessionEntry command is the basename (resume hints gate on it).
    expect(
      internals(manager).sessions.get("installed-resume-1")!.command,
    ).toBe("claude-agent-acp");
  });

  test("missing binary on resume surfaces the actionable bun install hint", async () => {
    insertHistoryRow({ id: "no-bin-1" });
    resolveImpl = () => ({
      ok: false,
      reason: "binary_not_found",
      hint: "bun add -g @agentclientprotocol/claude-agent-acp",
      command: "claude-agent-acp",
    });

    const manager = new AcpSessionManager(4);
    await expect(
      manager.resumeFromHistory("no-bin-1", () => {}),
    ).rejects.toThrow(
      "claude-agent-acp is not on PATH. bun add -g @agentclientprotocol/claude-agent-acp",
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

  test("concurrent resumes of the same id: one wins, the loser fails cleanly without leaking a process", async () => {
    fakeCaps.resume = true;
    insertHistoryRow({ id: "race-1" });

    const manager = new AcpSessionManager(4);
    const sent: ServerMessage[] = [];
    const [a, b] = await Promise.allSettled([
      manager.resumeFromHistory("race-1", (msg) => sent.push(msg)),
      manager.resumeFromHistory("race-1", (msg) => sent.push(msg)),
    ]);

    // Exactly one resume wins; the other fails the synchronous guard.
    expect([a.status, b.status].sort()).toEqual(["fulfilled", "rejected"]);
    const rejected = (a.status === "rejected" ? a : b) as PromiseRejectedResult;
    expect(String(rejected.reason)).toContain("is already active");

    // Only one child process was ever constructed and it is still alive
    // (the loser never got far enough to spawn-and-leak a second one).
    expect(fakeInstances).toHaveLength(1);
    expect(fakeInstances[0]!.killed).toBe(false);
    expect((manager.getStatus("race-1") as AcpSessionState).status).toBe(
      "running",
    );
    // Exactly one spawned event went out (single stream, not doubled).
    expect(sent.filter((m) => m.type === "acp_session_spawned")).toHaveLength(
      1,
    );
  });

  test("concurrent resumes of distinct ids cannot exceed maxConcurrent", async () => {
    fakeCaps.resume = true;
    insertHistoryRow({ id: "cap-1" });
    insertHistoryRow({ id: "cap-2" });

    const manager = new AcpSessionManager(1);
    const [a, b] = await Promise.allSettled([
      manager.resumeFromHistory("cap-1", () => {}),
      manager.resumeFromHistory("cap-2", () => {}),
    ]);

    expect([a.status, b.status].sort()).toEqual(["fulfilled", "rejected"]);
    const rejected = (a.status === "rejected" ? a : b) as PromiseRejectedResult;
    expect(String(rejected.reason)).toMatch(
      /ACP concurrency limit reached \(max 1\)/,
    );
    expect(fakeInstances).toHaveLength(1);
    expect(manager.getStatus() as AcpSessionState[]).toHaveLength(1);
  });

  test("getActiveAndPendingIds surfaces a resume still awaiting env prep", async () => {
    fakeCaps.resume = true;
    insertHistoryRow({ id: "pending-vis-1" });
    let release!: () => void;
    prepareAgentEnvGate = new Promise((res) => {
      release = res;
    });

    const manager = new AcpSessionManager(4);
    const promise = manager.resumeFromHistory("pending-vis-1", () => {});

    // Mid-resume: no SessionEntry yet (getStatus throws not-found), but the
    // id must already be visible to the delete guards.
    expect(() => manager.getStatus("pending-vis-1")).toThrow(/not found/);
    expect(manager.getActiveAndPendingIds()).toEqual(["pending-vis-1"]);

    release();
    await promise;

    // After the resume lands the id comes from the sessions map and the
    // reservation is gone (no duplicate).
    expect(manager.getActiveAndPendingIds()).toEqual(["pending-vis-1"]);
    expect(internals(manager).pendingResumes.size).toBe(0);
  });

  test("dispose during prepareAgentEnv aborts the resume before any process spawns", async () => {
    fakeCaps.resume = true;
    insertHistoryRow({ id: "dispose-1" });
    let release!: () => void;
    prepareAgentEnvGate = new Promise((res) => {
      release = res;
    });

    const manager = new AcpSessionManager(4);
    const promise = manager.resumeFromHistory("dispose-1", () => {});
    manager.dispose();
    release();

    await expect(promise).rejects.toThrow(/disposed/);
    // No child process was ever constructed on the disposed manager, and
    // the reservation was released.
    expect(fakeInstances).toHaveLength(0);
    expect(internals(manager).pendingResumes.size).toBe(0);
    expect(internals(manager).sessions.size).toBe(0);
    expect(internals(manager).eventBuffers.size).toBe(0);
  });

  test("cancel on a resumed session with no in-flight prompt persists and tears down", async () => {
    fakeCaps.resume = true;
    insertHistoryRow({
      id: "idle-1",
      eventLogJson: JSON.stringify([PERSISTED_EVENT]),
    });

    const manager = new AcpSessionManager(4);
    await manager.resumeFromHistory("idle-1", () => {});

    // No prompt is in flight, so cancel() itself must own the terminal
    // persistence + teardown (there is no prompt handler to do it).
    await manager.cancel("idle-1");

    expect(fakeInstances[0]!.killed).toBe(true);
    expect(internals(manager).sessions.has("idle-1")).toBe(false);
    expect(internals(manager).eventBuffers.has("idle-1")).toBe(false);

    const row = readHistoryRow("idle-1")!;
    expect(row.status).toBe("cancelled");
    expect(row.completed_at).not.toBeNull();
    // The re-seeded event log survived the cancel-side persistence.
    const log = JSON.parse(row.event_log_json) as Array<{ content?: string }>;
    expect(log).toHaveLength(1);
    expect(log[0]!.content).toBe("original-run-chunk");
  });
});

describe("AcpSessionManager.steerOrResume", () => {
  test("steers an in-memory session directly without a resume", async () => {
    fakeCaps.resume = true;
    insertHistoryRow({ id: "sor-live-1" });

    const manager = new AcpSessionManager(4);
    await manager.resumeFromHistory("sor-live-1", () => {});
    expect(fakeInstances).toHaveLength(1);

    const result = await manager.steerOrResume(
      "sor-live-1",
      "go faster",
      () => {},
    );
    expect(result).toEqual({ resumed: false });
    // No second process was constructed.
    expect(fakeInstances).toHaveLength(1);
    expect(fakeInstances[0]!.promptCalls).toEqual([
      { sessionId: "proto-old", text: "go faster" },
    ]);
  });

  test("session not in memory: resumes from history and fires the instruction atomically", async () => {
    fakeCaps.resume = true;
    insertHistoryRow({ id: "sor-resume-1" });

    const manager = new AcpSessionManager(4);
    const sent: ServerMessage[] = [];
    const result = await manager.steerOrResume(
      "sor-resume-1",
      "continue the work",
      (msg) => sent.push(msg),
    );

    expect(result).toEqual({ resumed: true });
    const fake = fakeInstances[0]!;
    expect(fake.resumeSessionCalls).toEqual([
      { sessionId: "proto-old", cwd: "/tmp/proj" },
    ]);
    // The instruction prompt fired immediately after the resume - the
    // session never sat running-idle with no in-flight prompt.
    expect(fake.promptCalls).toEqual([
      { sessionId: "proto-old", text: "continue the work" },
    ]);
    expect(sent.filter((m) => m.type === "acp_session_spawned")).toHaveLength(
      1,
    );
  });

  test("missing history row keeps the typed not-found error", async () => {
    const manager = new AcpSessionManager(4);
    const promise = manager.steerOrResume("sor-missing-1", "go", () => {});
    await expect(promise).rejects.toBeInstanceOf(AcpSessionNotFoundError);
  });

  test("resume failure surfaces as AcpResumeError with the actionable hint", async () => {
    insertHistoryRow({ id: "sor-legacy-1", cwd: null });

    const manager = new AcpSessionManager(4);
    const promise = manager.steerOrResume("sor-legacy-1", "go", () => {});
    await expect(promise).rejects.toBeInstanceOf(AcpResumeError);
    await expect(promise).rejects.toThrow(/recorded before resume support/);
  });

  test("concurrent steerOrResume on the same id: the loser awaits the in-flight resume and steers", async () => {
    fakeCaps.resume = true;
    insertHistoryRow({ id: "sor-race-1" });

    const manager = new AcpSessionManager(4);
    const sent: ServerMessage[] = [];
    const [a, b] = await Promise.all([
      manager.steerOrResume("sor-race-1", "first instruction", (msg) =>
        sent.push(msg),
      ),
      manager.steerOrResume("sor-race-1", "second instruction", (msg) =>
        sent.push(msg),
      ),
    ]);

    // Neither caller got the misleading "already active" resume error;
    // both landed their instruction on the single resumed session.
    expect(a).toEqual({ resumed: true });
    expect(b).toEqual({ resumed: true });
    expect(fakeInstances).toHaveLength(1);
    const fake = fakeInstances[0]!;
    expect(fake.resumeSessionCalls).toHaveLength(1);
    expect(fake.promptCalls.map((c) => c.text).sort()).toEqual([
      "first instruction",
      "second instruction",
    ]);
    // Single spawned event: one resume happened, not two.
    expect(sent.filter((m) => m.type === "acp_session_spawned")).toHaveLength(
      1,
    );
    expect((manager.getStatus("sor-race-1") as AcpSessionState).status).toBe(
      "running",
    );
  });

  test("steerOrResume arriving in the initializing window awaits the in-flight resume and steers", async () => {
    fakeCaps.resume = true;
    insertHistoryRow({ id: "sor-init-1" });
    let release!: () => void;
    resumeSessionGate = new Promise((res) => {
      release = res;
    });

    const manager = new AcpSessionManager(4);
    const sent: ServerMessage[] = [];
    const first = manager.steerOrResume("sor-init-1", "first instruction", (msg) =>
      sent.push(msg),
    );

    // Advance microtasks until the first call's resume has registered its
    // SessionEntry but is still gated inside resumeSession: the session
    // exists in memory with status "initializing".
    while (!internals(manager).sessions.has("sor-init-1")) {
      await Promise.resolve();
    }
    expect((manager.getStatus("sor-init-1") as AcpSessionState).status).toBe(
      "initializing",
    );

    // A steerOrResume in this window previously rethrew the plain
    // "is not running (status: initializing)" error and dropped the
    // instruction. It must instead await the in-flight resume and retry.
    const second = manager.steerOrResume(
      "sor-init-1",
      "second instruction",
      (msg) => sent.push(msg),
    );
    // Let the second call hit the initializing steer failure and park on
    // the in-flight resume before releasing the gate.
    await Promise.resolve();
    await Promise.resolve();
    release();

    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual({ resumed: true });
    expect(b).toEqual({ resumed: true });

    // Exactly one process was constructed and one resume happened; both
    // instructions landed on the single resumed session after it settled.
    expect(fakeInstances).toHaveLength(1);
    const fake = fakeInstances[0]!;
    expect(fake.resumeSessionCalls).toHaveLength(1);
    expect(fake.promptCalls.map((c) => c.text).sort()).toEqual([
      "first instruction",
      "second instruction",
    ]);
    expect(sent.filter((m) => m.type === "acp_session_spawned")).toHaveLength(
      1,
    );
    expect((manager.getStatus("sor-init-1") as AcpSessionState).status).toBe(
      "running",
    );
  });

  test("post-resume steer failure tears the resumed session down instead of leaving it idle", async () => {
    fakeCaps.resume = true;
    insertHistoryRow({ id: "sor-fail-1" });

    const manager = new AcpSessionManager(4);
    promptThrowsSync = true;
    const promise = manager.steerOrResume("sor-fail-1", "go", () => {});
    await expect(promise).rejects.toBeInstanceOf(AcpResumeError);
    await expect(promise).rejects.toThrow("prompt transport dead");

    // The resumed session did not leak: process killed, maps cleared,
    // terminal row persisted.
    expect(fakeInstances[0]!.killed).toBe(true);
    expect(internals(manager).sessions.has("sor-fail-1")).toBe(false);
    expect(internals(manager).eventBuffers.has("sor-fail-1")).toBe(false);
    expect(readHistoryRow("sor-fail-1")!.status).toBe("cancelled");
  });
});
