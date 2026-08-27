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
  latestUsage?: {
    usedTokens: number;
    contextSize: number;
    costAmount?: number;
    costCurrency?: string;
    inputTokens?: number;
    outputTokens?: number;
  };
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
    getBufferedUpdates: () => [],
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
import * as pendingInteractions from "../../pending-interactions.js";

let approvalBehavior: "allow" | "deny" = "allow";
const confirmationRequests: Array<Record<string, unknown>> = [];
const broadcasts: Array<Record<string, unknown>> = [];

mock.module("../../assistant-event-hub.js", () => ({
  broadcastMessage: (msg: { type?: string; requestId?: string }) => {
    broadcasts.push(msg as Record<string, unknown>);
    if (msg?.type !== "confirmation_request") {
      return;
    }
    confirmationRequests.push(msg as Record<string, unknown>);
    const interaction = pendingInteractions.resolve(
      msg.requestId as string,
      approvalBehavior === "allow" ? "approved" : "rejected",
    );
    interaction?.directResolve?.(approvalBehavior);
  },
}));

// The credential a spawn would resolve, which every credential-failure marker
// is compared against before it is served. Only the vault read is stubbed:
// the comparison itself stays real, and spreading the module keeps every other
// export intact for consumers that reach for one.
let fakeStoredCredential: string | undefined;
const realMarkerStore = await import("../../../acp/acp-auth-marker-store.js");
const realClaudeOauth = await import("../../../acp/acp-claude-oauth.js");
mock.module("../../../acp/acp-claude-oauth.js", () => ({
  ...realClaudeOauth,
  storedClaudeTokenDigest: async () => fakeStoredCredential,
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
import { initializeDb } from "../../../persistence/db-init.js";
import { FailedDependencyError, NotFoundError } from "../errors.js";

const { ROUTES } = await import("../acp-routes.js");
const { _resetAdapterInstallCacheForTests } =
  await import("../../../acp/auto-install.js");

await initializeDb();

afterAll(() => {
  which.restore();
});

function getSessionsHandler() {
  const route = ROUTES.find(
    (r) => r.endpoint === "acp/sessions" && r.method === "GET",
  );
  if (!route) {
    throw new Error("acp/sessions GET route not found");
  }
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
    usedTokens?: number;
    contextSize?: number;
    inputTokens?: number;
    outputTokens?: number;
    eventLog?: unknown[];
    authErrorCode?: string;
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
  fakeStoredCredential = undefined;
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
    // In-memory sessions carry eventLog from the live ring buffer (empty here).
    expect(body.sessions[0].eventLog).toEqual([]);
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

  test("returns input/output tokens for live and history sessions", async () => {
    fakeInMemorySessions = [
      {
        id: "live-tokens",
        agentId: "agent-live",
        acpSessionId: "proto-live",
        parentConversationId: "conv-live",
        status: "running",
        startedAt: 9000,
        latestUsage: {
          usedTokens: 1200,
          contextSize: 200_000,
          inputTokens: 5000,
          outputTokens: 800,
        },
      },
    ];
    insertHistoryRow({
      id: "hist-tokens",
      agentId: "agent-hist",
      acpSessionId: "proto-hist",
      parentConversationId: "conv-hist",
      startedAt: 1000,
      status: "completed",
      usedTokens: 4200,
      contextSize: 200_000,
      inputTokens: 3300,
      outputTokens: 450,
    });

    const handler = getSessionsHandler();
    const body = (await handler({})) as ResponseShape;
    const live = body.sessions.find((s) => s.id === "live-tokens");
    const hist = body.sessions.find((s) => s.id === "hist-tokens");
    expect(live).toMatchObject({ inputTokens: 5000, outputTokens: 800 });
    expect(hist).toMatchObject({ inputTokens: 3300, outputTokens: 450 });
  });

  test("omits input/output tokens for history rows without them", async () => {
    insertHistoryRow({
      id: "hist-no-tokens",
      status: "completed",
      startedAt: 1000,
    });

    const handler = getSessionsHandler();
    const body = (await handler({})) as ResponseShape;
    const s = body.sessions.find((row) => row.id === "hist-no-tokens");
    expect(s).toBeDefined();
    expect(s!.inputTokens).toBeUndefined();
    expect(s!.outputTokens).toBeUndefined();
  });

  test("dedupes by id with in-memory winning on collision", async () => {
    // Same id in both layers — in-memory entry should win and its eventLog
    // comes from the live ring buffer (empty here), not the stale history row.
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
    expect(body.sessions[0].eventLog).toEqual([]);
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
  if (!route) {
    throw new Error("acp/spawn POST route not found");
  }
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
      if (cmd === "bun") {
        return BUN_BIN;
      }
      if (binaryOnPath) {
        return `/usr/local/bin/${cmd}`;
      }
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
      if (cmd === "bun") {
        return BUN_BIN;
      }
      if (binaryOnPath) {
        return `/usr/local/bin/${cmd}`;
      }
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
  if (!route) {
    throw new Error("acp/:id/steer POST route not found");
  }
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

describe("GET /v1/acp/sessions: a marker answers for itself", () => {
  const REFUSED = realMarkerStore.claudeTokenDigest("sk-ant-oat-refused");
  const REPLACEMENT = realMarkerStore.claudeTokenDigest("sk-ant-oat-new");

  function markedRow(overrides: Record<string, unknown> = {}) {
    insertHistoryRow({
      id: "hist-auth",
      agentId: "claude",
      acpSessionId: "proto-auth",
      parentConversationId: "conv-auth",
      startedAt: 5000,
      completedAt: 6000,
      status: "failed",
      eventLogJson: "[]",
      authErrorCode: "acp_claude_auth_required",
      authErrorCredential: REFUSED,
      ...overrides,
    });
  }

  test("serves the marker while the refused credential is still the stored one", async () => {
    markedRow();
    fakeStoredCredential = REFUSED;

    const handler = getSessionsHandler();
    const body = (await handler({
      queryParams: { conversationId: "conv-auth" },
    })) as ResponseShape;

    expect(body.sessions[0].authErrorCode).toBe("acp_claude_auth_required");
  });

  test("withholds it once a different credential is stored", async () => {
    // The user completed Connect. Nothing swept the row; the comparison is
    // what stops the card rendering, so it needs no ordering to be right.
    markedRow();
    fakeStoredCredential = REPLACEMENT;

    const handler = getSessionsHandler();
    const body = (await handler({
      queryParams: { conversationId: "conv-auth" },
    })) as ResponseShape;

    expect(body.sessions[0].authErrorCode).toBeUndefined();
  });

  test("withholding it twice gives the same answer", async () => {
    // The sweep this replaced could only run once, which is why a restart or a
    // second client used to be able to lose the answer.
    markedRow();
    fakeStoredCredential = REPLACEMENT;

    const handler = getSessionsHandler();
    const first = (await handler({
      queryParams: { conversationId: "conv-auth" },
    })) as ResponseShape;
    const second = (await handler({
      queryParams: { conversationId: "conv-auth" },
    })) as ResponseShape;

    expect(first.sessions[0].authErrorCode).toBeUndefined();
    expect(second.sessions[0].authErrorCode).toBeUndefined();
  });

  test("serves a marker naming no credential rather than hiding it", async () => {
    // Written before the credential column existed. An unknown credential is
    // no evidence the failure was repaired.
    markedRow({ authErrorCredential: null });
    fakeStoredCredential = REPLACEMENT;

    const handler = getSessionsHandler();
    const body = (await handler({
      queryParams: { conversationId: "conv-auth" },
    })) as ResponseShape;

    expect(body.sessions[0].authErrorCode).toBe("acp_claude_auth_required");
  });

  test("serves the marker when the vault holds nothing", async () => {
    markedRow();
    fakeStoredCredential = undefined;

    const handler = getSessionsHandler();
    const body = (await handler({
      queryParams: { conversationId: "conv-auth" },
    })) as ResponseShape;

    expect(body.sessions[0].authErrorCode).toBe("acp_claude_auth_required");
  });
});

describe("GET /v1/acp/sessions: markers resolve against configured tokens too", () => {
  const REFUSED = realMarkerStore.claudeTokenDigest("sk-ant-oat-refused");
  const CONFIGURED = "sk-ant-oat-configured-repair";

  function markedRow() {
    insertHistoryRow({
      id: "hist-cfg",
      agentId: "claude",
      acpSessionId: "proto-cfg",
      parentConversationId: "conv-cfg",
      startedAt: 5000,
      completedAt: 6000,
      status: "failed",
      eventLogJson: "[]",
      authErrorCode: "acp_claude_auth_required",
      authErrorCredential: REFUSED,
    });
  }

  test("withholds the marker when config supplies the repaired token", async () => {
    // The user fixed auth by setting `acp.agents.claude.env`, not by
    // connecting. Config wins at spawn, so the next run uses the repaired
    // token and the old failure is not going to repeat. A vault-only
    // comparison would keep restoring the card forever, since the vault still
    // holds the refused value.
    markedRow();
    fakeStoredCredential = REFUSED;
    config.setConfig({
      agents: {
        claude: {
          command: "claude-agent-acp",
          args: [],
          env: { CLAUDE_CODE_OAUTH_TOKEN: CONFIGURED },
        },
      },
    });

    const handler = getSessionsHandler();
    const body = (await handler({
      queryParams: { conversationId: "conv-cfg" },
    })) as ResponseShape;

    expect(body.sessions[0].authErrorCode).toBeUndefined();
  });

  test("serves it when the configured token is the one that was refused", async () => {
    markedRow();
    fakeStoredCredential = undefined;
    config.setConfig({
      agents: {
        claude: {
          command: "claude-agent-acp",
          args: [],
          env: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-refused" },
        },
      },
    });

    const handler = getSessionsHandler();
    const body = (await handler({
      queryParams: { conversationId: "conv-cfg" },
    })) as ResponseShape;

    expect(body.sessions[0].authErrorCode).toBe("acp_claude_auth_required");
  });

  test("never puts the credential digest on the wire", async () => {
    markedRow();
    fakeStoredCredential = REFUSED;

    const handler = getSessionsHandler();
    const body = (await handler({
      queryParams: { conversationId: "conv-cfg" },
    })) as ResponseShape;

    expect(body.sessions[0]).not.toHaveProperty("authErrorCredential");
  });
});

describe("GET /v1/acp/sessions: retired markers do not accumulate past the page", () => {
  const REFUSED = realMarkerStore.claudeTokenDigest("sk-ant-oat-refused");
  const REPLACEMENT = realMarkerStore.claudeTokenDigest("sk-ant-oat-new");

  test("stale marked rows outside the page are dropped, not carried along", async () => {
    // Marker columns are retained rather than cleared, so every failure a
    // conversation has ever had still carries one. Letting them escape the
    // page before the comparison strikes the repaired ones grows the response
    // without limit, and a client that reads a full page as truncated then
    // stops retiring runs missing from it.
    for (let i = 0; i < 6; i++) {
      insertHistoryRow({
        id: `hist-old-${i}`,
        agentId: "claude",
        acpSessionId: `proto-old-${i}`,
        parentConversationId: "conv-many",
        startedAt: 1000 + i,
        completedAt: 2000 + i,
        status: "failed",
        eventLogJson: "[]",
        authErrorCode: "acp_claude_auth_required",
        authErrorCredential: REFUSED,
      });
    }
    // Newer unmarked runs fill the page.
    for (let i = 0; i < 3; i++) {
      insertHistoryRow({
        id: `hist-new-${i}`,
        agentId: "claude",
        acpSessionId: `proto-new-${i}`,
        parentConversationId: "conv-many",
        startedAt: 9000 + i,
        completedAt: 9500 + i,
        status: "completed",
        eventLogJson: "[]",
      });
    }
    fakeStoredCredential = REPLACEMENT;

    const handler = getSessionsHandler();
    const body = (await handler({
      queryParams: { conversationId: "conv-many", limit: "3" },
    })) as ResponseShape;

    expect(body.sessions).toHaveLength(3);
    expect(body.sessions.map((s) => s.id)).toEqual([
      "hist-new-2",
      "hist-new-1",
      "hist-new-0",
    ]);
  });

  test("a marker that is still current does escape the page", async () => {
    insertHistoryRow({
      id: "hist-live-marker",
      agentId: "claude",
      acpSessionId: "proto-live-marker",
      parentConversationId: "conv-many",
      startedAt: 1000,
      completedAt: 2000,
      status: "failed",
      eventLogJson: "[]",
      authErrorCode: "acp_claude_auth_required",
      authErrorCredential: REFUSED,
    });
    for (let i = 0; i < 3; i++) {
      insertHistoryRow({
        id: `hist-fill-${i}`,
        agentId: "claude",
        acpSessionId: `proto-fill-${i}`,
        parentConversationId: "conv-many",
        startedAt: 9000 + i,
        completedAt: 9500 + i,
        status: "completed",
        eventLogJson: "[]",
      });
    }
    fakeStoredCredential = REFUSED;

    const handler = getSessionsHandler();
    const body = (await handler({
      queryParams: { conversationId: "conv-many", limit: "3" },
    })) as ResponseShape;

    expect(body.sessions).toHaveLength(4);
    expect(body.sessions.map((s) => s.id)).toContain("hist-live-marker");
  });
});

describe("GET /v1/acp/sessions: current markers are bounded too", () => {
  const REFUSED = realMarkerStore.claudeTokenDigest("sk-ant-oat-refused");

  test("only the newest marked run escapes the page", async () => {
    // Repeated failures against a credential that is still current all keep
    // their markers, since nothing clears them. The restore path takes the
    // newest marked run and stops, so letting the rest escape would grow the
    // response by a full event log apiece for no one's benefit.
    for (let i = 0; i < 5; i++) {
      insertHistoryRow({
        id: `hist-marked-${i}`,
        agentId: "claude",
        acpSessionId: `proto-marked-${i}`,
        parentConversationId: "conv-repeat",
        startedAt: 1000 + i,
        completedAt: 2000 + i,
        status: "failed",
        eventLogJson: "[]",
        parentToolUseId: `tool-${i}`,
        authErrorCode: "acp_claude_auth_required",
        authErrorCredential: REFUSED,
      });
    }
    for (let i = 0; i < 2; i++) {
      insertHistoryRow({
        id: `hist-recent-${i}`,
        agentId: "claude",
        acpSessionId: `proto-recent-${i}`,
        parentConversationId: "conv-repeat",
        startedAt: 9000 + i,
        completedAt: 9500 + i,
        status: "completed",
        eventLogJson: "[]",
      });
    }
    fakeStoredCredential = REFUSED;

    const handler = getSessionsHandler();
    const body = (await handler({
      queryParams: { conversationId: "conv-repeat", limit: "2" },
    })) as ResponseShape;

    // The page, plus exactly one escaped marker: the newest of the five.
    expect(body.sessions).toHaveLength(3);
    expect(body.sessions[2].id).toBe("hist-marked-4");
  });

  test("markers inside the page are all returned", async () => {
    // The cap is on escaping the page, not on markers as such.
    for (let i = 0; i < 3; i++) {
      insertHistoryRow({
        id: `hist-inpage-${i}`,
        agentId: "claude",
        acpSessionId: `proto-inpage-${i}`,
        parentConversationId: "conv-inpage",
        startedAt: 1000 + i,
        completedAt: 2000 + i,
        status: "failed",
        eventLogJson: "[]",
        parentToolUseId: `tool-in-${i}`,
        authErrorCode: "acp_claude_auth_required",
        authErrorCredential: REFUSED,
      });
    }
    fakeStoredCredential = REFUSED;

    const handler = getSessionsHandler();
    const body = (await handler({
      queryParams: { conversationId: "conv-inpage", limit: "10" },
    })) as ResponseShape;

    expect(body.sessions).toHaveLength(3);
    expect(
      body.sessions.every(
        (s) => s.authErrorCode === "acp_claude_auth_required",
      ),
    ).toBe(true);
  });
});

describe("GET /v1/acp/sessions: the marker past the page is looked up, not filtered", () => {
  const REFUSED = realMarkerStore.claudeTokenDigest("sk-ant-oat-refused");
  const CURRENT = realMarkerStore.claudeTokenDigest("sk-ant-oat-current");

  test("reaches the newest current marker past a run of stale ones", async () => {
    // Newest-first, the markers go: stale, stale, current. Taking the newest
    // marked row and judging it afterwards would return nothing; the lookup
    // has to ask for the newest row whose credential still matches.
    const rows: Array<[string, number, string]> = [
      ["hist-current", 3000, CURRENT],
      ["hist-stale-a", 4000, REFUSED],
      ["hist-stale-b", 5000, REFUSED],
    ];
    for (const [id, startedAt, credential] of rows) {
      insertHistoryRow({
        id,
        agentId: "claude",
        acpSessionId: `proto-${id}`,
        parentConversationId: "conv-mixed",
        startedAt,
        completedAt: startedAt + 1,
        status: "failed",
        eventLogJson: "[]",
        parentToolUseId: `tool-${id}`,
        authErrorCode: "acp_claude_auth_required",
        authErrorCredential: credential,
      });
    }
    insertHistoryRow({
      id: "hist-recent",
      agentId: "claude",
      acpSessionId: "proto-recent",
      parentConversationId: "conv-mixed",
      startedAt: 9000,
      completedAt: 9001,
      status: "completed",
      eventLogJson: "[]",
    });
    fakeStoredCredential = CURRENT;

    const handler = getSessionsHandler();
    const body = (await handler({
      queryParams: { conversationId: "conv-mixed", limit: "1" },
    })) as ResponseShape;

    expect(body.sessions.map((s) => s.id)).toEqual([
      "hist-recent",
      "hist-current",
    ]);
    expect(body.sessions[1].authErrorCode).toBe("acp_claude_auth_required");
  });

  test("reaches nothing when every marker is stale", async () => {
    insertHistoryRow({
      id: "hist-only-stale",
      agentId: "claude",
      acpSessionId: "proto-only-stale",
      parentConversationId: "conv-all-stale",
      startedAt: 1000,
      completedAt: 1001,
      status: "failed",
      eventLogJson: "[]",
      parentToolUseId: "tool-stale",
      authErrorCode: "acp_claude_auth_required",
      authErrorCredential: REFUSED,
    });
    insertHistoryRow({
      id: "hist-newer",
      agentId: "claude",
      acpSessionId: "proto-newer",
      parentConversationId: "conv-all-stale",
      startedAt: 9000,
      completedAt: 9001,
      status: "completed",
      eventLogJson: "[]",
    });
    fakeStoredCredential = CURRENT;

    const handler = getSessionsHandler();
    const body = (await handler({
      queryParams: { conversationId: "conv-all-stale", limit: "1" },
    })) as ResponseShape;

    expect(body.sessions.map((s) => s.id)).toEqual(["hist-newer"]);
  });
});

describe("GET /v1/acp/sessions: a marker in the merged overflow", () => {
  const REFUSED = realMarkerStore.claudeTokenDigest("sk-ant-oat-refused");

  test("surfaces a marker the page cut, even when history was read to the end", async () => {
    // In-memory sessions merge on top of the history read, so the merged list
    // can overflow the page while the query still reached the end of the
    // table. The marker the client needs can be sitting in that overflow, and
    // the short read is no proof it does not exist.
    fakeInMemorySessions = [
      {
        id: "live-a",
        agentId: "claude",
        acpSessionId: "proto-live-a",
        parentConversationId: "conv-overflow",
        status: "running",
        startedAt: 9000,
      },
      {
        id: "live-b",
        agentId: "claude",
        acpSessionId: "proto-live-b",
        parentConversationId: "conv-overflow",
        status: "running",
        startedAt: 9001,
      },
    ];
    insertHistoryRow({
      id: "hist-marked",
      agentId: "claude",
      acpSessionId: "proto-marked",
      parentConversationId: "conv-overflow",
      startedAt: 1000,
      completedAt: 1001,
      status: "failed",
      eventLogJson: "[]",
      parentToolUseId: "tool-marked",
      authErrorCode: "acp_claude_auth_required",
      authErrorCredential: REFUSED,
    });
    fakeStoredCredential = REFUSED;

    const handler = getSessionsHandler();
    const body = (await handler({
      queryParams: { conversationId: "conv-overflow", limit: "2" },
    })) as ResponseShape;

    expect(body.sessions).toHaveLength(3);
    expect(body.sessions[2].id).toBe("hist-marked");
    expect(body.sessions[2].authErrorCode).toBe("acp_claude_auth_required");
  });

  test("a stale marker in the overflow is not surfaced", async () => {
    fakeInMemorySessions = [
      {
        id: "live-c",
        agentId: "claude",
        acpSessionId: "proto-live-c",
        parentConversationId: "conv-overflow-stale",
        status: "running",
        startedAt: 9000,
      },
    ];
    insertHistoryRow({
      id: "hist-stale",
      agentId: "claude",
      acpSessionId: "proto-stale",
      parentConversationId: "conv-overflow-stale",
      startedAt: 1000,
      completedAt: 1001,
      status: "failed",
      eventLogJson: "[]",
      parentToolUseId: "tool-stale",
      authErrorCode: "acp_claude_auth_required",
      authErrorCredential: REFUSED,
    });
    fakeStoredCredential = realMarkerStore.claudeTokenDigest("sk-ant-oat-new");

    const handler = getSessionsHandler();
    const body = (await handler({
      queryParams: { conversationId: "conv-overflow-stale", limit: "1" },
    })) as ResponseShape;

    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0].id).toBe("live-c");
  });
});
