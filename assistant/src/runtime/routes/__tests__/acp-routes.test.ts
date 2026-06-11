/**
 * Tests for ACP route handlers.
 *
 * `GET /v1/acp/sessions`: the handler merges in-memory
 * `AcpSessionManager.getStatus()` output with persisted
 * `acp_session_history` rows, deduping by id (in-memory wins), filtering by
 * `?conversationId`, sorting newest-first, and truncating to `?limit`
 * (default 50, max 500).
 *
 * `POST /v1/acp/spawn`: when the adapter binary is missing, the handler
 * silently auto-installs allowlisted adapter packages via a sandboxed `bun`
 * global install before failing with the install hint. `execFile` is stubbed
 * via the shared `installExecFileStub` helper so tests can script
 * `bun add --global` outcomes.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import { installAcpConfigStub } from "../../../acp/__tests__/helpers/acp-config-stub.js";
import { installExecFileStub } from "../../../acp/__tests__/helpers/exec-file-stub.js";
import { installWhichStub } from "../../../acp/__tests__/helpers/which-stub.js";

mock.module("../../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

const {
  execScripts,
  execFileMock,
  reset: resetExecFileStub,
} = installExecFileStub();

// ---------------------------------------------------------------------------
// Stub the ACP session manager so tests control the in-memory side without
// spawning real child processes. The route handler imports
// `getAcpSessionManager` from `../../../acp/index.js`; we replace that
// module's export with a getter that returns whatever the current test set.
// ---------------------------------------------------------------------------

interface FakeSessionState {
  id: string;
  agentId: string;
  acpSessionId: string;
  parentConversationId: string;
  status: string;
  startedAt: number;
  completedAt?: number;
  error?: string;
  stopReason?: string;
}

let fakeInMemorySessions: FakeSessionState[] = [];

const spawnMock = mock(async () => ({
  acpSessionId: "acp-route-session",
  protocolSessionId: "proto-route-session",
}));

const defaultSteerOrResumeImpl = async (
  _id: string,
  _instruction: string,
): Promise<{ resumed: boolean }> => ({ resumed: false });
let steerOrResumeImpl: (
  id: string,
  instruction: string,
) => Promise<{ resumed: boolean }> = defaultSteerOrResumeImpl;
const steerOrResumeMock = mock(
  (id: string, instruction: string, _send: unknown) =>
    steerOrResumeImpl(id, instruction),
);

mock.module("../../../acp/index.js", () => ({
  getAcpSessionManager: () => ({
    getStatus: () => fakeInMemorySessions,
    getActiveAndPendingIds: () => fakeInMemorySessions.map((s) => s.id),
    spawn: spawnMock,
    steerOrResume: steerOrResumeMock,
  }),
}));

// Identity env-prep: the credential-broker plumbing it wraps is exercised in
// its own suite; spawn tests here only care about the resolve/install flow.
mock.module("../../../acp/prepare-agent-env.js", () => ({
  prepareAgentEnv: async (agentConfig: unknown) => agentConfig,
}));

// The spawn route and steer's resume branch gate on a high-risk approval
// (ATL-822) before starting the host agent. These tests pin the
// resolve/install/resume flow, so the hub mock auto-resolves the freshly
// registered confirmation the same way `POST /v1/confirm` would (resolve +
// directResolve). `approvalBehavior` flips allow/deny; `confirmationRequests`
// captures the prompts. Other event types are ignored.
import * as pendingInteractions from "../../../runtime/pending-interactions.js";

let approvalBehavior: "allow" | "deny" = "allow";
const confirmationRequests: Array<Record<string, unknown>> = [];
const broadcasts: Array<Record<string, unknown>> = [];

mock.module("../../../runtime/assistant-event-hub.js", () => ({
  broadcastMessage: (msg: { type?: string; requestId?: string }) => {
    broadcasts.push(msg as Record<string, unknown>);
    if (msg?.type !== "confirmation_request") return;
    confirmationRequests.push(msg as Record<string, unknown>);
    const interaction = pendingInteractions.resolve(
      msg.requestId as string,
      approvalBehavior === "allow" ? "approved" : "rejected",
    );
    interaction?.directResolve?.(approvalBehavior);
  },
}));

/** Drain pending micro/macrotasks so background resume work settles. */
const flushAsync = () => new Promise((resolve) => setTimeout(resolve, 0));

const config = await installAcpConfigStub();
const which = installWhichStub();

import {
  clearHistory,
  insertHistoryRow,
} from "../../../acp/__tests__/helpers/acp-history-db.js";
import {
  AcpResumeError,
  AcpSessionNotFoundError,
} from "../../../acp/session-manager.js";
import { initializeDb } from "../../../memory/db-init.js";
import { FailedDependencyError, NotFoundError } from "../errors.js";

const { ROUTES } = await import("../acp-routes.js");
const { _resetAdapterInstallCacheForTests } =
  await import("../../../acp/auto-install.js");

initializeDb();

afterAll(() => {
  which.restore();
});

function getSessionsHandler() {
  const route = ROUTES.find(
    (r) => r.endpoint === "acp/sessions" && r.method === "GET",
  );
  if (!route) throw new Error("acp/sessions GET route not found");
  return route.handler;
}

interface ResponseShape {
  sessions: Array<{
    id: string;
    agentId: string;
    acpSessionId: string;
    parentConversationId?: string;
    status: string;
    startedAt: number;
    completedAt?: number | null;
    stopReason?: string | null;
    error?: string | null;
    eventLog?: unknown[];
  }>;
}

beforeEach(() => {
  fakeInMemorySessions = [];
  clearHistory();
  resetExecFileStub();
  spawnMock.mockClear();
  steerOrResumeMock.mockClear();
  steerOrResumeImpl = defaultSteerOrResumeImpl;
  _resetAdapterInstallCacheForTests();
  config.setConfig({});
  which.setWhich((cmd) => `/usr/local/bin/${cmd}`);
  approvalBehavior = "allow";
  confirmationRequests.length = 0;
  broadcasts.length = 0;
});

describe("GET /v1/acp/sessions — merged in-memory + history", () => {
  test("returns an empty array when no sessions exist", async () => {
    const handler = getSessionsHandler();
    const body = (await handler({})) as ResponseShape;
    expect(body.sessions).toEqual([]);
  });

  test("returns only in-memory sessions when history is empty", async () => {
    fakeInMemorySessions = [
      {
        id: "live-1",
        agentId: "agent-A",
        acpSessionId: "proto-1",
        parentConversationId: "conv-x",
        status: "running",
        startedAt: 1000,
      },
    ];

    const handler = getSessionsHandler();
    const body = (await handler({})) as ResponseShape;
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0]).toMatchObject({
      id: "live-1",
      agentId: "agent-A",
      acpSessionId: "proto-1",
      parentConversationId: "conv-x",
      status: "running",
      startedAt: 1000,
    });
    // No eventLog on in-memory sessions.
    expect(body.sessions[0].eventLog).toBeUndefined();
  });

  test("returns only history rows when no in-memory sessions exist", async () => {
    insertHistoryRow({
      id: "hist-1",
      agentId: "agent-B",
      acpSessionId: "proto-h1",
      parentConversationId: "conv-y",
      startedAt: 2000,
      completedAt: 3000,
      status: "completed",
      stopReason: "end_turn",
      eventLogJson: JSON.stringify([
        {
          type: "acp_session_update",
          acpSessionId: "hist-1",
          updateType: "agent_message_chunk",
          content: "hello",
        },
      ]),
    });

    const handler = getSessionsHandler();
    const body = (await handler({})) as ResponseShape;
    expect(body.sessions).toHaveLength(1);
    const s = body.sessions[0];
    expect(s.id).toBe("hist-1");
    expect(s.parentConversationId).toBe("conv-y");
    expect(s.status).toBe("completed");
    expect(s.stopReason).toBe("end_turn");
    expect(s.completedAt).toBe(3000);
    // event log was deserialized from event_log_json.
    expect(s.eventLog).toEqual([
      {
        type: "acp_session_update",
        acpSessionId: "hist-1",
        updateType: "agent_message_chunk",
        content: "hello",
      },
    ]);
  });

  test("dedupes by id with in-memory winning on collision", async () => {
    // Same id in both layers — in-memory entry should win and eventLog
    // (which only history carries) must be absent on the merged record.
    fakeInMemorySessions = [
      {
        id: "shared-1",
        agentId: "agent-live",
        acpSessionId: "proto-live",
        parentConversationId: "conv-live",
        status: "running",
        startedAt: 5000,
      },
    ];
    insertHistoryRow({
      id: "shared-1",
      agentId: "agent-stale",
      acpSessionId: "proto-stale",
      parentConversationId: "conv-stale",
      startedAt: 1000,
      completedAt: 1500,
      status: "completed",
      stopReason: "end_turn",
      eventLogJson: JSON.stringify([{ stale: true }]),
    });

    const handler = getSessionsHandler();
    const body = (await handler({})) as ResponseShape;
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0].agentId).toBe("agent-live");
    expect(body.sessions[0].status).toBe("running");
    expect(body.sessions[0].startedAt).toBe(5000);
    expect(body.sessions[0].eventLog).toBeUndefined();
  });

  test("merges in-memory and disjoint history rows", async () => {
    fakeInMemorySessions = [
      {
        id: "live-1",
        agentId: "agent-A",
        acpSessionId: "proto-1",
        parentConversationId: "conv-1",
        status: "running",
        startedAt: 3000,
      },
    ];
    insertHistoryRow({
      id: "hist-1",
      agentId: "agent-B",
      acpSessionId: "proto-h1",
      parentConversationId: "conv-2",
      startedAt: 1000,
      status: "completed",
    });

    const handler = getSessionsHandler();
    const body = (await handler({})) as ResponseShape;
    expect(body.sessions).toHaveLength(2);
    // Sorted newest-first by startedAt.
    expect(body.sessions[0].id).toBe("live-1");
    expect(body.sessions[1].id).toBe("hist-1");
  });

  test("?limit truncates the merged set after sorting", async () => {
    // Two in-memory + three history rows → 5 total. Limit to 2.
    fakeInMemorySessions = [
      {
        id: "live-newest",
        agentId: "agent-A",
        acpSessionId: "proto-A",
        parentConversationId: "conv-1",
        status: "running",
        startedAt: 5000,
      },
      {
        id: "live-mid",
        agentId: "agent-A",
        acpSessionId: "proto-A2",
        parentConversationId: "conv-1",
        status: "running",
        startedAt: 3000,
      },
    ];
    insertHistoryRow({
      id: "hist-old",
      agentId: "agent-B",
      acpSessionId: "proto-B",
      parentConversationId: "conv-2",
      startedAt: 1000,
      status: "completed",
    });
    insertHistoryRow({
      id: "hist-older",
      agentId: "agent-B",
      acpSessionId: "proto-B2",
      parentConversationId: "conv-2",
      startedAt: 500,
      status: "completed",
    });
    insertHistoryRow({
      id: "hist-mid",
      agentId: "agent-B",
      acpSessionId: "proto-B3",
      parentConversationId: "conv-2",
      startedAt: 4000,
      status: "completed",
    });

    const handler = getSessionsHandler();
    const body = (await handler({
      queryParams: { limit: "2" },
    })) as ResponseShape;
    expect(body.sessions).toHaveLength(2);
    expect(body.sessions.map((s) => s.id)).toEqual(["live-newest", "hist-mid"]);
  });

  test("?conversationId filters both in-memory and history entries", async () => {
    fakeInMemorySessions = [
      {
        id: "live-match",
        agentId: "agent-A",
        acpSessionId: "p1",
        parentConversationId: "conv-target",
        status: "running",
        startedAt: 4000,
      },
      {
        id: "live-other",
        agentId: "agent-A",
        acpSessionId: "p2",
        parentConversationId: "conv-other",
        status: "running",
        startedAt: 3500,
      },
    ];
    insertHistoryRow({
      id: "hist-match",
      agentId: "agent-B",
      acpSessionId: "p3",
      parentConversationId: "conv-target",
      startedAt: 2000,
      status: "completed",
    });
    insertHistoryRow({
      id: "hist-other",
      agentId: "agent-B",
      acpSessionId: "p4",
      parentConversationId: "conv-other",
      startedAt: 1000,
      status: "completed",
    });

    const handler = getSessionsHandler();
    const body = (await handler({
      queryParams: { conversationId: "conv-target" },
    })) as ResponseShape;
    expect(body.sessions.map((s) => s.id)).toEqual([
      "live-match",
      "hist-match",
    ]);
  });

  test("?limit clamps to the maximum (500)", async () => {
    // Insert 3 rows; ensure a wildly-too-large limit doesn't error and the
    // response is bounded by row count rather than the requested value.
    insertHistoryRow({
      id: "h1",
      agentId: "a",
      acpSessionId: "p1",
      parentConversationId: "c",
      startedAt: 100,
      status: "completed",
    });
    insertHistoryRow({
      id: "h2",
      agentId: "a",
      acpSessionId: "p2",
      parentConversationId: "c",
      startedAt: 200,
      status: "completed",
    });
    insertHistoryRow({
      id: "h3",
      agentId: "a",
      acpSessionId: "p3",
      parentConversationId: "c",
      startedAt: 300,
      status: "completed",
    });

    const handler = getSessionsHandler();
    const body = (await handler({
      queryParams: { limit: "9999" },
    })) as ResponseShape;
    expect(body.sessions).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// POST /v1/acp/spawn: auto-install on missing adapter binary
// ---------------------------------------------------------------------------

function getSpawnHandler() {
  const route = ROUTES.find(
    (r) => r.endpoint === "acp/spawn" && r.method === "POST",
  );
  if (!route) throw new Error("acp/spawn POST route not found");
  return route.handler;
}

const SPAWN_BODY = {
  agent: "claude",
  task: "do something",
  conversationId: "conv-1",
};

const BUN_BIN = "/usr/local/bin/bun";
const BUN_ADD_KEY = `${BUN_BIN} add`;

describe("POST /v1/acp/spawn: sandboxed bun auto-install on missing binary", () => {
  test("known command + bun present: installs via bun, then spawns the real binary", async () => {
    // Binary appears on PATH only after `bun add --global` runs, simulating a
    // successful global install that links the adapter bin onto PATH.
    let binaryOnPath = false;
    which.setWhich((cmd) => {
      if (cmd === "bun") return BUN_BIN;
      if (binaryOnPath) return `/usr/local/bin/${cmd}`;
      return null;
    });
    execScripts.set(BUN_ADD_KEY, {
      stdout: "",
      onCall: () => {
        binaryOnPath = true;
      },
    });

    const handler = getSpawnHandler();
    const body = (await handler({ body: SPAWN_BODY })) as Record<
      string,
      unknown
    >;

    expect(body).toEqual({
      acpSessionId: "acp-route-session",
      protocolSessionId: "proto-route-session",
      agent: "claude",
    });
    expect(spawnMock).toHaveBeenCalledTimes(1);
    // The real adapter binary is spawned, not a `bun x` wrapper.
    const agentConfigArg = (spawnMock.mock.calls[0] as unknown[])[1] as {
      command: string;
    };
    expect(agentConfigArg.command).toBe("claude-agent-acp");
    // Exactly one install, and it was `bun add --global` (never npm).
    expect(execFileMock).toHaveBeenCalledTimes(1);
    const [command, args] = execFileMock.mock.calls[0];
    expect(command).toBe(BUN_BIN);
    expect(args).toEqual([
      "add",
      "--global",
      "@agentclientprotocol/claude-agent-acp",
    ]);
  });

  test("install runs in a temp dir (not the task cwd) with secrets stripped", async () => {
    let binaryOnPath = false;
    which.setWhich((cmd) => {
      if (cmd === "bun") return BUN_BIN;
      if (binaryOnPath) return `/usr/local/bin/${cmd}`;
      return null;
    });
    execScripts.set(BUN_ADD_KEY, {
      stdout: "",
      onCall: () => {
        binaryOnPath = true;
      },
    });

    const handler = getSpawnHandler();
    await handler({ body: { ...SPAWN_BODY, cwd: "/untrusted/project" } });

    const options = execFileMock.mock.calls[0][2] as {
      cwd?: string;
      env?: NodeJS.ProcessEnv;
    };
    expect(options.cwd).not.toBe("/untrusted/project");
    expect(options.cwd).toContain("vellum-acp-install-");
    expect(options.env?.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(options.env?.GEMINI_API_KEY).toBeUndefined();
    expect(options.env?.BUN_CONFIG_REGISTRY).toBe(
      "https://registry.npmjs.org/",
    );
  });

  test("bun absent: no install attempted, FailedDependencyError with the hint", async () => {
    which.setWhich({}); // neither bun nor the adapter on PATH

    const handler = getSpawnHandler();
    const promise = handler({ body: SPAWN_BODY });
    await expect(promise).rejects.toBeInstanceOf(FailedDependencyError);
    await expect(promise).rejects.toThrow(
      /claude-agent-acp is not on PATH.*bun add -g @agentclientprotocol\/claude-agent-acp/,
    );
    expect(execFileMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  test("install failure: FailedDependencyError carries hint and failure reason, never npm", async () => {
    which.setWhich({ bun: BUN_BIN });
    execScripts.set(BUN_ADD_KEY, {
      error: new Error("EACCES: permission denied"),
    });

    const handler = getSpawnHandler();
    const promise = handler({ body: SPAWN_BODY });
    await expect(promise).rejects.toBeInstanceOf(FailedDependencyError);
    await expect(promise).rejects.toThrow(
      /claude-agent-acp is not on PATH.*bun add -g @agentclientprotocol\/claude-agent-acp.*auto-install failed.*EACCES/,
    );
    for (const call of execFileMock.mock.calls) {
      expect(call[0]).not.toBe("npm");
    }
    expect(spawnMock).not.toHaveBeenCalled();
  });

  test("unknown command: plain hint maps to FailedDependencyError", async () => {
    // The allowlist itself (no npm invocation for unmapped commands) is
    // pinned in auto-install.test.ts and spawn.test.ts; this asserts only
    // the route's transport mapping of the plain-hint failure.
    config.setConfig({
      agents: { custom: { command: "custom-bin", args: [] } },
    });
    which.setWhich({});

    const handler = getSpawnHandler();
    const promise = handler({ body: { ...SPAWN_BODY, agent: "custom" } });
    await expect(promise).rejects.toBeInstanceOf(FailedDependencyError);
    await expect(promise).rejects.toThrow(
      "custom-bin is not on PATH. Install 'custom-bin' and ensure it is on PATH.",
    );
  });
});

// ---------------------------------------------------------------------------
// POST /v1/acp/:id/steer: transparent resume of sessions not in memory
// ---------------------------------------------------------------------------

function getSteerHandler() {
  const route = ROUTES.find(
    (r) => r.endpoint === "acp/:id/steer" && r.method === "POST",
  );
  if (!route) throw new Error("acp/:id/steer POST route not found");
  return route.handler;
}

describe("POST /v1/acp/:id/steer: resume fallback", () => {
  test("in-memory session steers without a resume", async () => {
    const handler = getSteerHandler();
    const body = await handler({
      pathParams: { id: "live-1" },
      body: { instruction: "redirect" },
    });

    expect(body).toEqual({ acpSessionId: "live-1", steered: true });
    expect(steerOrResumeMock).toHaveBeenCalledTimes(1);
    expect(steerOrResumeMock.mock.calls[0][0]).toBe("live-1");
    expect(steerOrResumeMock.mock.calls[0][1]).toBe("redirect");
    expect(typeof steerOrResumeMock.mock.calls[0][2]).toBe("function");
  });

  test("resumed session reports the resumed flag", async () => {
    steerOrResumeImpl = async () => ({ resumed: true });

    const handler = getSteerHandler();
    const body = await handler({
      pathParams: { id: "gone-1" },
      body: { instruction: "keep going" },
    });

    expect(body).toEqual({
      acpSessionId: "gone-1",
      steered: true,
      resumed: true,
    });
  });

  test("typed not-found (no session, no history row) maps to NotFoundError", async () => {
    steerOrResumeImpl = async (id) => {
      throw new AcpSessionNotFoundError(id);
    };

    const handler = getSteerHandler();
    const promise = handler({
      pathParams: { id: "missing-1" },
      body: { instruction: "go" },
    });
    await expect(promise).rejects.toBeInstanceOf(NotFoundError);
  });

  test("resume failure surfaces as FailedDependencyError with the actionable hint", async () => {
    steerOrResumeImpl = async (id) => {
      throw new AcpResumeError(
        new Error(
          `ACP session "${id}" was recorded before resume support ` +
            `(no working directory persisted) and cannot be resumed. ` +
            `Spawn a new session instead.`,
        ),
      );
    };

    const handler = getSteerHandler();
    const promise = handler({
      pathParams: { id: "legacy-1" },
      body: { instruction: "go" },
    });
    await expect(promise).rejects.toBeInstanceOf(FailedDependencyError);
    await expect(promise).rejects.toThrow(/recorded before resume support/);
  });

  test("plain steer errors map to NotFoundError", async () => {
    steerOrResumeImpl = async (id) => {
      throw new Error(
        `ACP session "${id}" is not running (status: initializing)`,
      );
    };

    const handler = getSteerHandler();
    const promise = handler({
      pathParams: { id: "init-1" },
      body: { instruction: "go" },
    });
    await expect(promise).rejects.toBeInstanceOf(NotFoundError);
  });
});

// ---------------------------------------------------------------------------
// POST /v1/acp/:id/steer: resume crosses the host-spawn boundary, so it is
// gated by the same high-risk guardian approval as spawn (ATL-822). Steering
// a session still active in memory only redirects an already-approved live
// process and is NOT prompted.
// ---------------------------------------------------------------------------

describe("POST /v1/acp/:id/steer: resume approval gate", () => {
  test("acks immediately with approvalPending, then resumes once granted", async () => {
    insertHistoryRow({
      id: "gone-1",
      agentId: "claude",
      parentConversationId: "conv-z",
      status: "completed",
      cwd: "/work/repo",
    });
    steerOrResumeImpl = async () => ({ resumed: true });

    const handler = getSteerHandler();
    // The ack returns before the (async) resume completes, so a slow guardian
    // approval can't trip the client's short ack timeout (ATL-822 / Codex P2).
    const body = await handler({
      pathParams: { id: "gone-1" },
      body: { instruction: "keep going" },
    });
    expect(body).toEqual({
      acpSessionId: "gone-1",
      steered: false,
      approvalPending: true,
    });

    // The high-risk prompt is surfaced for the resume.
    expect(confirmationRequests).toHaveLength(1);
    const prompt = confirmationRequests[0];
    expect(prompt.toolName).toBe("acp_steer");
    expect(prompt.riskLevel).toBe("high");
    expect(prompt.executionTarget).toBe("host");
    expect(prompt.conversationId).toBe("conv-z");
    expect((prompt.input as { cwd?: string }).cwd).toBe("/work/repo");

    // After approval settles, the background worker performs the resume.
    await flushAsync();
    expect(steerOrResumeMock).toHaveBeenCalledTimes(1);
    expect(steerOrResumeMock.mock.calls[0][0]).toBe("gone-1");
  });

  test("denied resume never reaches the session manager and reports an error event", async () => {
    approvalBehavior = "deny";
    insertHistoryRow({
      id: "gone-2",
      acpSessionId: "proto-gone-2",
      parentConversationId: "conv-z",
      status: "completed",
      cwd: "/work/repo",
    });

    const handler = getSteerHandler();
    const body = await handler({
      pathParams: { id: "gone-2" },
      body: { instruction: "do evil" },
    });
    expect(body).toEqual({
      acpSessionId: "gone-2",
      steered: false,
      approvalPending: true,
    });

    await flushAsync();
    // Denied before any host re-spawn, and the denial surfaces over SSE.
    expect(steerOrResumeMock).not.toHaveBeenCalled();
    expect(pendingInteractions.getAll()).toHaveLength(0);
    // Keyed by the daemon/route id (what SSE consumers index by), not the
    // persisted protocol id.
    const errEvent = broadcasts.find((m) => m.type === "acp_session_error");
    expect(errEvent?.acpSessionId).toBe("gone-2");
  });

  test("a legacy row without a persisted cwd is not resumable, so no prompt", async () => {
    insertHistoryRow({ id: "legacy-2", status: "completed", cwd: null });
    steerOrResumeImpl = async (id) => {
      throw new AcpResumeError(
        new Error(`ACP session "${id}" cannot be resumed.`),
      );
    };

    const handler = getSteerHandler();
    await expect(
      handler({ pathParams: { id: "legacy-2" }, body: { instruction: "go" } }),
    ).rejects.toBeInstanceOf(FailedDependencyError);
    // No spawn would occur, so the gate stays out of the way.
    expect(confirmationRequests).toHaveLength(0);
  });

  test("steering a session active in memory is not prompted", async () => {
    fakeInMemorySessions = [
      {
        id: "live-2",
        agentId: "claude",
        acpSessionId: "proto-live-2",
        parentConversationId: "conv-1",
        status: "running",
        startedAt: 1000,
      },
    ];
    // A resumable row also exists, but the in-memory session wins → steer.
    insertHistoryRow({ id: "live-2", status: "completed", cwd: "/work/repo" });

    const handler = getSteerHandler();
    const body = await handler({
      pathParams: { id: "live-2" },
      body: { instruction: "redirect" },
    });

    expect(confirmationRequests).toHaveLength(0);
    expect(body).toEqual({ acpSessionId: "live-2", steered: true });
    expect(steerOrResumeMock).toHaveBeenCalledTimes(1);
  });
});
