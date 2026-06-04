/**
 * Tests for the ACP route handlers.
 *
 * Suites:
 *  - POST /v1/acp/spawn — the three failure paths produced by
 *    `resolveAcpAgent` (acp_disabled, unknown_agent, binary_not_found).
 *  - POST /v1/acp/spawn (env injection) — CLAUDE_CODE_OAUTH_TOKEN is read
 *    from the credential broker (policy-gated + audited) and merged into
 *    `agentConfig.env` ONLY for the `claude` agent.
 *  - DELETE /v1/acp/sessions?status=completed — the bulk-clear route that
 *    wipes terminal-state rows (completed/failed/cancelled) from
 *    `acp_session_history` while leaving running/initializing rows intact.
 *  - DELETE /v1/acp/sessions/:id — single-row delete: completed → 200,
 *    running → 409, unknown id → idempotent { deleted: false }.
 *
 * The spawn tests mirror the resolver's test setup using the shared
 * `installAcpConfigStub` and `installWhichStub` helpers so the host
 * environment doesn't influence the resolver's PATH preflight.
 *
 * The single-id delete tests stub `getAcpSessionManager` so we can drive
 * the in-memory-status check without spawning real ACP child processes,
 * and use the real DB (initialized via the test preload's per-file
 * workspace) to verify the row is actually removed.
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

import { installAcpConfigStub } from "../../acp/__tests__/helpers/acp-config-stub.js";
import { installWhichStub } from "../../acp/__tests__/helpers/which-stub.js";
import type { AcpSessionState } from "../../acp/index.js";

const config = await installAcpConfigStub();
const which = installWhichStub();

afterAll(() => {
  which.restore();
});

// Stub `getAcpSessionManager` so the DELETE /:id tests can drive the
// in-memory-status check without spawning real ACP processes, and so the
// env-injection spawn tests can capture the `agentConfig` arg without
// launching a real subprocess. Stored in mutable state so individual tests
// can plant arbitrary states / inspect capture.
const inMemoryStates = new Map<string, AcpSessionState>();

interface CapturedSpawn {
  agent: string;
  agentConfig: { env?: Record<string, string> };
  task: string;
  conversationId: string;
}

const capturedSpawns: CapturedSpawn[] = [];

// Records ids passed to manager.close() so the idle delete/bulk-clear tests
// can assert the session was actually torn down. close() also evicts the
// in-memory state, mirroring the real teardown (so a subsequent getStatus no
// longer surfaces the session, matching the real map removal).
const closedSessionIds: string[] = [];

// Records (id, instruction) pairs passed to manager.steer so the
// acp/continue route tests can assert the follow-up reached the right
// session. Set `steerShouldThrow` to simulate a closed/non-reusable session.
interface SteerCall {
  id: string;
  instruction: string;
}
const steerCalls: SteerCall[] = [];
let steerShouldThrow = false;
// Most-recent live session returned by getLiveSessionForConversation, keyed
// by conversation id; absent → null (no live session).
const liveByConversation = new Map<string, AcpSessionState>();

mock.module("../../acp/index.js", () => ({
  getAcpSessionManager: () => ({
    steer: async (id: string, instruction: string) => {
      if (steerShouldThrow) throw new Error(`ACP session "${id}" not found`);
      steerCalls.push({ id, instruction });
    },
    getLiveSessionForConversation: (conversationId: string) =>
      liveByConversation.get(conversationId) ?? null,
    getStatus: (id?: string) => {
      if (id === undefined) {
        return Array.from(inMemoryStates.values());
      }
      const state = inMemoryStates.get(id);
      if (!state) throw new Error(`ACP session "${id}" not found`);
      return state;
    },
    close: (id: string) => {
      const state = inMemoryStates.get(id);
      if (!state) throw new Error(`ACP session "${id}" not found`);
      closedSessionIds.push(id);
      inMemoryStates.delete(id);
    },
    spawn: async (
      agent: string,
      agentConfig: { env?: Record<string, string> },
      task: string,
      _cwd: string | undefined,
      conversationId: string,
    ) => {
      capturedSpawns.push({ agent, agentConfig, task, conversationId });
      return { acpSessionId: "acp-test", protocolSessionId: "proto-test" };
    },
  }),
}));

// Stub credential broker + metadata store so env-injection tests can plant
// a known token (or absence) without touching the real credential store.
// The broker mock mirrors the real serverUse policy: metadata must exist
// and allowedTools must include the requesting tool.
const vaultStore = new Map<string, string>();
const metadataStore = new Map<
  string,
  { allowedTools: string[]; usageDescription?: string }
>();

mock.module("../../tools/credentials/metadata-store.js", () => ({
  // acp-routes.js (the module under test) also exports the credential-link
  // route, which imports assertMetadataWritable from this module. Since the
  // mock replaces the whole module, it must provide that export too.
  assertMetadataWritable: () => {},
  getCredentialMetadata: (service: string, field: string) => {
    const key = `${service}/${field}`;
    const entry = metadataStore.get(key);
    if (!entry) return undefined;
    return {
      credentialId: `cred-${key}`,
      service,
      field,
      allowedTools: entry.allowedTools,
      allowedDomains: [],
      usageDescription: entry.usageDescription,
      createdAt: 0,
      updatedAt: 0,
    };
  },
  upsertCredentialMetadata: (
    service: string,
    field: string,
    policy?: { allowedTools?: string[]; usageDescription?: string },
  ) => {
    const key = `${service}/${field}`;
    const existing = metadataStore.get(key);
    metadataStore.set(key, {
      allowedTools: policy?.allowedTools ?? existing?.allowedTools ?? [],
      usageDescription: policy?.usageDescription ?? existing?.usageDescription,
    });
    return {
      credentialId: `cred-${key}`,
      service,
      field,
      allowedTools: metadataStore.get(key)!.allowedTools,
      allowedDomains: [],
      createdAt: 0,
      updatedAt: 0,
    };
  },
}));

mock.module("../../tools/credentials/broker.js", () => ({
  credentialBroker: {
    serverUse: async <T>(request: {
      service: string;
      field: string;
      toolName: string;
      execute: (value: string) => Promise<T>;
    }) => {
      const key = `${request.service}/${request.field}`;
      const meta = metadataStore.get(key);
      if (!meta) {
        return { success: false, reason: `No credential found for ${key}` };
      }
      if (!meta.allowedTools.includes(request.toolName)) {
        return {
          success: false,
          reason: `Tool "${request.toolName}" not allowed`,
        };
      }
      const value = vaultStore.get(key);
      if (!value) {
        return { success: false, reason: `No stored value for ${key}` };
      }
      const result = await request.execute(value);
      return { success: true, result };
    },
  },
}));

import { eq } from "drizzle-orm";

import { getDb, getSqlite } from "../../memory/db-connection.js";
import { initializeDb } from "../../memory/db-init.js";
import { acpSessionHistory } from "../../memory/schema.js";

const { ROUTES } = await import("./acp-routes.js");

function getSpawnHandler() {
  const route = ROUTES.find(
    (r: { endpoint: string; method: string }) =>
      r.endpoint === "acp/spawn" && r.method === "POST",
  );
  if (!route) throw new Error("acp/spawn route not registered");
  return route.handler;
}

beforeEach(() => {
  config.setConfig({});
  which.setWhich((cmd) => `/usr/local/bin/${cmd}`);
  capturedSpawns.length = 0;
  closedSessionIds.length = 0;
  steerCalls.length = 0;
  steerShouldThrow = false;
  liveByConversation.clear();
  vaultStore.clear();
  metadataStore.clear();
});

// ---------------------------------------------------------------------------
// POST /v1/acp/continue — follow-up turn on an existing live session
// ---------------------------------------------------------------------------

function getContinueHandler() {
  const route = ROUTES.find(
    (r: { endpoint: string; method: string }) =>
      r.endpoint === "acp/continue" && r.method === "POST",
  );
  if (!route) throw new Error("acp/continue route not registered");
  return route.handler;
}

/** Seed an in-memory session state so the continue route's getStatus + the
 * delete-route status checks resolve it. */
function seedInMemoryState(
  id: string,
  status: AcpSessionState["status"],
): void {
  inMemoryStates.set(id, {
    id,
    agentId: "claude",
    acpSessionId: `proto-${id}`,
    parentConversationId: "conv-1",
    status,
    startedAt: 1,
  });
}

describe("POST /v1/acp/continue", () => {
  beforeEach(() => {
    inMemoryStates.clear();
  });

  test("explicit acpSessionId: follow-up reaches that session via steer", async () => {
    seedInMemoryState("acp-123", "idle");
    const handler = getContinueHandler();
    const result = (await handler({
      body: { acpSessionId: "acp-123", instruction: "now add tests" },
    })) as { acpSessionId: string; continued: boolean };

    expect(result).toEqual({ acpSessionId: "acp-123", continued: true });
    expect(steerCalls).toEqual([
      { id: "acp-123", instruction: "now add tests" },
    ]);
  });

  test("resolves the conversation's live session when acpSessionId is omitted", async () => {
    liveByConversation.set("conv-1", {
      id: "acp-live",
      agentId: "claude",
      acpSessionId: "proto-live",
      parentConversationId: "conv-1",
      status: "idle",
      startedAt: 1,
    });

    const handler = getContinueHandler();
    const result = (await handler({
      body: { conversationId: "conv-1", instruction: "keep going" },
    })) as { acpSessionId: string; continued: boolean };

    expect(result).toEqual({ acpSessionId: "acp-live", continued: true });
    expect(steerCalls).toEqual([{ id: "acp-live", instruction: "keep going" }]);
  });

  test("missing instruction throws 400", async () => {
    const handler = getContinueHandler();
    await expect(
      handler({ body: { acpSessionId: "acp-123" } }),
    ).rejects.toThrow("instruction is required");
    expect(steerCalls).toEqual([]);
  });

  test("no acpSessionId and no conversationId throws 400", async () => {
    const handler = getContinueHandler();
    await expect(handler({ body: { instruction: "go" } })).rejects.toThrow(
      "acpSessionId or conversationId is required",
    );
  });

  test("no live session for the conversation throws 404", async () => {
    const handler = getContinueHandler();
    await expect(
      handler({ body: { conversationId: "conv-none", instruction: "go" } }),
    ).rejects.toThrow("No live ACP session");
    expect(steerCalls).toEqual([]);
  });

  test("explicit unknown session id: getStatus miss maps to 404 without steering", async () => {
    // Not seeded → getStatus throws → 404, and steer is never reached.
    const handler = getContinueHandler();
    await expect(
      handler({ body: { acpSessionId: "acp-gone", instruction: "go" } }),
    ).rejects.toThrow("ACP session not found or not reusable");
    expect(steerCalls).toEqual([]);
  });

  test("closed/non-reusable session: steer rejection maps to 404", async () => {
    // Resolves as idle via getStatus, but steer rejects (adapter torn down
    // between the status read and the steer).
    seedInMemoryState("acp-gone", "idle");
    steerShouldThrow = true;
    const handler = getContinueHandler();
    await expect(
      handler({ body: { acpSessionId: "acp-gone", instruction: "go" } }),
    ).rejects.toThrow("ACP session not found or not reusable");
  });

  test("explicit running session: rejects with 409 and does NOT steer", async () => {
    seedInMemoryState("acp-busy", "running");
    const handler = getContinueHandler();
    await expect(
      handler({ body: { acpSessionId: "acp-busy", instruction: "also do X" } }),
    ).rejects.toThrow("is busy");
    // The in-flight prompt is preserved — steer was never called.
    expect(steerCalls).toEqual([]);
  });

  test("conversation-resolved running session: rejects with 409 and does NOT steer", async () => {
    liveByConversation.set("conv-busy", {
      id: "acp-live-busy",
      agentId: "claude",
      acpSessionId: "proto-live-busy",
      parentConversationId: "conv-busy",
      status: "running",
      startedAt: 1,
    });
    const handler = getContinueHandler();
    await expect(
      handler({ body: { conversationId: "conv-busy", instruction: "go" } }),
    ).rejects.toThrow("is busy");
    expect(steerCalls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// POST /v1/acp/spawn — failure paths from resolveAcpAgent
// ---------------------------------------------------------------------------

describe("POST /v1/acp/spawn", () => {
  test("throws BadRequestError when ACP is disabled", async () => {
    config.setConfig({ enabled: false });

    const handler = getSpawnHandler();
    await expect(
      handler({
        body: {
          agent: "claude",
          task: "do a thing",
          conversationId: "conv-1",
        },
      }),
    ).rejects.toThrow("acp.enabled");
  });

  test("throws BadRequestError with merged available list when agent id is unknown", async () => {
    config.setConfig({
      agents: {
        "user-only": { command: "some-binary", args: [] },
      },
    });

    const handler = getSpawnHandler();
    await expect(
      handler({
        body: {
          agent: "nonexistent",
          task: "do a thing",
          conversationId: "conv-1",
        },
      }),
    ).rejects.toThrow('Unknown agent "nonexistent"');
  });

  test("throws FailedDependencyError when the agent binary is missing", async () => {
    config.setConfig({ agents: {} });
    which.setWhich({});

    const handler = getSpawnHandler();
    await expect(
      handler({
        body: {
          agent: "codex",
          task: "do a thing",
          conversationId: "conv-1",
        },
      }),
    ).rejects.toThrow("codex-acp is not on PATH");
  });

  test("body-shape guard short-circuits before the resolver runs", async () => {
    config.setConfig({ enabled: false });

    const handler = getSpawnHandler();
    await expect(handler({ body: { agent: "claude" } })).rejects.toThrow(
      "agent, task, and conversationId are required",
    );
  });
});

// ---------------------------------------------------------------------------
// POST /v1/acp/spawn — CLAUDE_CODE_OAUTH_TOKEN env injection + preflight
//
// claude-agent-acp authenticates via CLAUDE_CODE_OAUTH_TOKEN. The route
// accepts the token from two provisioning routes:
//   1. Credential broker (policy-gated + audited) reading from the secure
//      store — provisioned via `assistant credentials set --service acp
//      --field claude_oauth_token`.
//   2. `acp.agents.claude.env.CLAUDE_CODE_OAUTH_TOKEN` in the user's
//      config.json, surfaced on `resolved.agent.env` by the resolver.
// After broker-mediated resolution, the route preflights for the token
// and throws `FailedDependencyError` if it is still absent.
//
// These tests pin both the happy paths and the throw path so a future
// drift in the key path, the env-override route, or the preflight check
// fails the suite loudly.
// ---------------------------------------------------------------------------

/** Seed a vault entry to simulate `assistant credentials set`. */
function seedVaultToken(token: string): void {
  vaultStore.set("acp/claude_oauth_token", token);
}

describe("POST /v1/acp/spawn — CLAUDE_CODE_OAUTH_TOKEN injection", () => {
  test("injects CLAUDE_CODE_OAUTH_TOKEN from the vault via the broker for the claude agent", async () => {
    seedVaultToken("test-token-abc123");

    const handler = getSpawnHandler();
    await handler({
      body: {
        agent: "claude",
        task: "do a thing",
        conversationId: "conv-1",
      },
    });

    expect(capturedSpawns).toHaveLength(1);
    expect(capturedSpawns[0]?.agent).toBe("claude");
    expect(capturedSpawns[0]?.agentConfig.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe(
      "test-token-abc123",
    );
  });

  test("accepts CLAUDE_CODE_OAUTH_TOKEN from acp.agents.claude.env (config.json override) without a vault entry", async () => {
    config.setConfig({
      agents: {
        claude: {
          command: "claude-agent-acp",
          args: [],
          env: { CLAUDE_CODE_OAUTH_TOKEN: "config-token-xyz789" },
        },
      },
    });

    const handler = getSpawnHandler();
    await handler({
      body: {
        agent: "claude",
        task: "do a thing",
        conversationId: "conv-1",
      },
    });

    expect(capturedSpawns).toHaveLength(1);
    expect(capturedSpawns[0]?.agentConfig.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe(
      "config-token-xyz789",
    );
  });

  test("config.json env override wins over a vault token (precedence pin)", async () => {
    seedVaultToken("vault-token-AAA");
    config.setConfig({
      agents: {
        claude: {
          command: "claude-agent-acp",
          args: [],
          env: { CLAUDE_CODE_OAUTH_TOKEN: "config-token-BBB" },
        },
      },
    });

    const handler = getSpawnHandler();
    await handler({
      body: {
        agent: "claude",
        task: "do a thing",
        conversationId: "conv-1",
      },
    });

    expect(capturedSpawns).toHaveLength(1);
    expect(capturedSpawns[0]?.agentConfig.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe(
      "config-token-BBB",
    );
  });

  test("injects via command match for a user-defined agent id aliased to claude-agent-acp", async () => {
    seedVaultToken("vault-token-zzz");
    config.setConfig({
      agents: {
        "my-claude": {
          command: "claude-agent-acp",
          args: [],
        },
      },
    });

    const handler = getSpawnHandler();
    await handler({
      body: {
        agent: "my-claude",
        task: "do a thing",
        conversationId: "conv-1",
      },
    });

    expect(capturedSpawns).toHaveLength(1);
    expect(capturedSpawns[0]?.agent).toBe("my-claude");
    expect(capturedSpawns[0]?.agentConfig.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe(
      "vault-token-zzz",
    );
  });

  test("throws FailedDependencyError when no CLAUDE_CODE_OAUTH_TOKEN is available from any source", async () => {
    const handler = getSpawnHandler();
    await expect(
      handler({
        body: {
          agent: "claude",
          task: "do a thing",
          conversationId: "conv-1",
        },
      }),
    ).rejects.toThrow(/CLAUDE_CODE_OAUTH_TOKEN/);
    expect(capturedSpawns).toHaveLength(0);
  });

  test("does NOT inject CLAUDE_CODE_OAUTH_TOKEN for agents whose command is not claude-agent-acp", async () => {
    seedVaultToken("test-token-abc123");
    // The codex-acp path requires an OpenAI/Codex key; seed one so the spawn
    // succeeds and we can assert the CLAUDE token is NOT injected for it.
    vaultStore.set("acp/openai_api_key", "test-openai-key-abc123");

    const handler = getSpawnHandler();
    await handler({
      body: {
        agent: "codex",
        task: "do a thing",
        conversationId: "conv-1",
      },
    });

    expect(capturedSpawns).toHaveLength(1);
    expect(capturedSpawns[0]?.agent).toBe("codex");
    expect(
      capturedSpawns[0]?.agentConfig.env?.CLAUDE_CODE_OAUTH_TOKEN,
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// DELETE /v1/acp/sessions?status=completed — bulk-clear terminal rows
// ---------------------------------------------------------------------------

function getBulkDeleteHandler() {
  const route = ROUTES.find(
    (r: { endpoint: string; method: string }) =>
      r.endpoint === "acp/sessions" && r.method === "DELETE",
  );
  if (!route) throw new Error("DELETE acp/sessions route not registered");
  return route.handler;
}

function seedHistoryRow(id: string, status: string, startedAt: number): void {
  getDb()
    .insert(acpSessionHistory)
    .values({
      id,
      agentId: "agent-x",
      acpSessionId: `proto-${id}`,
      parentConversationId: "conv-test",
      startedAt,
      completedAt: status === "running" ? null : startedAt + 1000,
      status,
      stopReason: status === "completed" ? "end_turn" : null,
      error: status === "failed" ? "boom" : null,
      eventLogJson: "[]",
    })
    .run();
}

interface RowSnapshot {
  id: string;
  status: string;
}

function listRows(): RowSnapshot[] {
  return getSqlite()
    .query("SELECT id, status FROM acp_session_history ORDER BY id")
    .all() as RowSnapshot[];
}

describe("DELETE /v1/acp/sessions?status=completed", () => {
  beforeAll(() => {
    initializeDb();
  });

  beforeEach(() => {
    getSqlite().run("DELETE FROM acp_session_history");
  });

  test("removes only terminal-state rows; running/initializing rows survive", async () => {
    seedHistoryRow("row-completed", "completed", 1000);
    seedHistoryRow("row-failed", "failed", 2000);
    seedHistoryRow("row-cancelled", "cancelled", 3000);
    seedHistoryRow("row-running", "running", 4000);
    seedHistoryRow("row-initializing", "initializing", 5000);

    const handler = getBulkDeleteHandler();
    const result = (await handler({
      queryParams: { status: "completed" },
    })) as {
      deleted: number;
    };
    expect(result.deleted).toBe(3);

    const remaining = listRows();
    expect(remaining.map((r) => r.status).sort()).toEqual([
      "initializing",
      "running",
    ]);
  });

  test("returns deleted=0 when no terminal rows are present", async () => {
    seedHistoryRow("row-running", "running", 1000);

    const handler = getBulkDeleteHandler();
    const result = (await handler({
      queryParams: { status: "completed" },
    })) as {
      deleted: number;
    };
    expect(result.deleted).toBe(0);

    const remaining = listRows();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe("row-running");
  });

  test("rejects missing status query param with 400", async () => {
    seedHistoryRow("row-completed", "completed", 1000);

    const handler = getBulkDeleteHandler();
    expect(() => handler({})).toThrow("status");
    // Row must still be present — guard short-circuited before the delete.
    expect(listRows()).toHaveLength(1);
  });

  test("rejects status values other than 'completed' with 400", async () => {
    seedHistoryRow("row-completed", "completed", 1000);

    const handler = getBulkDeleteHandler();
    expect(() => handler({ queryParams: { status: "failed" } })).toThrow(
      "status",
    );
    expect(listRows()).toHaveLength(1);
  });

  test("closes in-memory idle sessions whose rows are cleared; leaves running untouched", async () => {
    // An idle session has already written a terminal `completed` row.
    seedHistoryRow("sess-idle", "completed", 1000);
    inMemoryStates.set("sess-idle", {
      id: "sess-idle",
      agentId: "claude",
      acpSessionId: "proto-idle",
      parentConversationId: "conv-1",
      status: "idle",
      startedAt: 1000,
    });
    // A running session — its (running) row is not terminal, must survive.
    seedHistoryRow("sess-running", "running", 2000);
    inMemoryStates.set("sess-running", {
      id: "sess-running",
      agentId: "claude",
      acpSessionId: "proto-running",
      parentConversationId: "conv-1",
      status: "running",
      startedAt: 2000,
    });

    const handler = getBulkDeleteHandler();
    const result = (await handler({
      queryParams: { status: "completed" },
    })) as { deleted: number };

    // The idle session was closed (torn down) before its row was cleared, so
    // it won't reappear on the next /acp/sessions refresh.
    expect(closedSessionIds).toEqual(["sess-idle"]);
    expect(inMemoryStates.has("sess-idle")).toBe(false);
    // The running session was NOT closed.
    expect(inMemoryStates.has("sess-running")).toBe(true);

    // Only the idle session's terminal row was deleted; the running row stays.
    expect(result.deleted).toBe(1);
    expect(listRows().map((r) => r.id)).toEqual(["sess-running"]);
  });
});

// ---------------------------------------------------------------------------
// DELETE /v1/acp/sessions/:id
// ---------------------------------------------------------------------------

function getDeleteSessionHandler() {
  const route = ROUTES.find(
    (r: { endpoint: string; method: string }) =>
      r.endpoint === "acp/sessions/:id" && r.method === "DELETE",
  );
  if (!route) throw new Error("acp/sessions/:id DELETE route not registered");
  return route.handler;
}

function insertHistoryRow(opts: {
  id: string;
  status: AcpSessionState["status"];
}) {
  getDb()
    .insert(acpSessionHistory)
    .values({
      id: opts.id,
      agentId: "claude",
      acpSessionId: `proto-${opts.id}`,
      parentConversationId: "conv-1",
      startedAt: 1_700_000_000_000,
      completedAt: 1_700_000_001_000,
      status: opts.status,
      stopReason: null,
      error: null,
      eventLogJson: "[]",
    })
    .run();
}

describe("DELETE /v1/acp/sessions/:id", () => {
  beforeAll(() => {
    initializeDb();
  });

  beforeEach(() => {
    inMemoryStates.clear();
    getDb().delete(acpSessionHistory).run();
  });

  test("removes a completed session row and returns { deleted: true }", async () => {
    insertHistoryRow({ id: "sess-completed", status: "completed" });

    const handler = getDeleteSessionHandler();
    const result = (await handler({
      pathParams: { id: "sess-completed" },
    })) as {
      deleted: boolean;
    };
    expect(result.deleted).toBe(true);

    // Row really gone.
    const remaining = getDb()
      .select()
      .from(acpSessionHistory)
      .where(eq(acpSessionHistory.id, "sess-completed"))
      .all();
    expect(remaining).toHaveLength(0);
  });

  test.each([["running" as const], ["initializing" as const]])(
    "returns 409 when the session is still %s in memory",
    async (status) => {
      inMemoryStates.set("sess-active", {
        id: "sess-active",
        agentId: "claude",
        acpSessionId: "proto-active",
        parentConversationId: "conv-1",
        status,
        startedAt: 1_700_000_000_000,
      });
      insertHistoryRow({ id: "sess-active", status: "completed" });

      const handler = getDeleteSessionHandler();
      expect(() => handler({ pathParams: { id: "sess-active" } })).toThrow(
        `still ${status}`,
      );

      // Row untouched.
      const remaining = getDb()
        .select()
        .from(acpSessionHistory)
        .where(eq(acpSessionHistory.id, "sess-active"))
        .all();
      expect(remaining).toHaveLength(1);
    },
  );

  test("idempotent for unknown id — returns { deleted: false }", async () => {
    const handler = getDeleteSessionHandler();
    const result = (await handler({
      pathParams: { id: "does-not-exist" },
    })) as { deleted: boolean };
    expect(result.deleted).toBe(false);
  });

  test("closes a live idle session, then deletes its row (no 409)", async () => {
    inMemoryStates.set("sess-idle", {
      id: "sess-idle",
      agentId: "claude",
      acpSessionId: "proto-idle",
      parentConversationId: "conv-1",
      status: "idle",
      startedAt: 1_700_000_000_000,
      completedAt: 1_700_000_001_000,
    });
    insertHistoryRow({ id: "sess-idle", status: "completed" });

    const handler = getDeleteSessionHandler();
    const result = (await handler({
      pathParams: { id: "sess-idle" },
    })) as { deleted: boolean };

    // The idle session was closed (teardown) before the row delete.
    expect(closedSessionIds).toEqual(["sess-idle"]);
    expect(inMemoryStates.has("sess-idle")).toBe(false);
    // The row was removed and success returned — no 409.
    expect(result.deleted).toBe(true);
    const remaining = getDb()
      .select()
      .from(acpSessionHistory)
      .where(eq(acpSessionHistory.id, "sess-idle"))
      .all();
    expect(remaining).toHaveLength(0);
  });

  test("deletes a cancelled in-memory session whose row is in history", async () => {
    inMemoryStates.set("sess-cancelled", {
      id: "sess-cancelled",
      agentId: "claude",
      acpSessionId: "proto-cancelled",
      parentConversationId: "conv-1",
      status: "cancelled",
      startedAt: 1_700_000_000_000,
      completedAt: 1_700_000_001_000,
    });
    insertHistoryRow({ id: "sess-cancelled", status: "cancelled" });

    const handler = getDeleteSessionHandler();
    const result = (await handler({
      pathParams: { id: "sess-cancelled" },
    })) as { deleted: boolean };
    expect(result.deleted).toBe(true);
  });
});
