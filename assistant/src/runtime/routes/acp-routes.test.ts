/**
 * Tests for the ACP route handlers.
 *
 * Suites:
 *  - POST /v1/acp/spawn: resolver failure paths (unknown_agent) and the
 *    body-shape guard. The binary_not_found / auto-install surface is
 *    covered in `__tests__/acp-routes.test.ts`.
 *  - POST /v1/acp/spawn (env injection) — CLAUDE_CODE_OAUTH_TOKEN is read
 *    from the credential broker (policy-gated + audited) and merged into
 *    `agentConfig.env` ONLY for the `claude` agent.
 *  - DELETE /v1/acp/sessions?status=completed — the bulk-clear route that
 *    wipes terminal-state rows (completed/failed/cancelled) from
 *    `acp_session_history` while leaving running/initializing rows and
 *    rows with an in-flight resume intact.
 *  - DELETE /v1/acp/sessions/:id — single-row delete: completed → 200,
 *    running or mid-resume → 409, unknown id → idempotent
 *    { deleted: false }.
 *
 * The spawn tests mirror the resolver's test setup using the shared
 * `installAcpConfigStub` and `installWhichStub` helpers so the host
 * environment doesn't influence the resolver's PATH preflight.
 *
 * The delete tests stub `getAcpSessionManager` so we can drive the
 * in-memory-status and pending-resume checks without spawning real ACP
 * child processes, and use the real DB (initialized via the test preload's
 * per-file workspace) to verify the row is actually removed.
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
import * as pendingInteractions from "../pending-interactions.js";

const config = await installAcpConfigStub();
const which = installWhichStub();

afterAll(() => {
  which.restore();
});

// Stub `getAcpSessionManager` so the DELETE /:id tests can drive the
// in-memory-status check without spawning real ACP processes, and so the
// env-injection spawn tests can capture the `agentConfig` arg without
// launching a real subprocess. Stored in mutable state so individual tests
// can plant arbitrary states / inspect capture. `pendingResumeIds` models
// ids reserved by an in-flight resumeFromHistory (no SessionEntry yet).
const inMemoryStates = new Map<string, AcpSessionState>();
const pendingResumeIds = new Set<string>();

interface CapturedSpawn {
  agent: string;
  agentConfig: { env?: Record<string, string> };
  task: string;
  conversationId: string;
}

const capturedSpawns: CapturedSpawn[] = [];

mock.module("../../acp/index.js", () => ({
  getAcpSessionManager: () => ({
    getStatus: (id?: string) => {
      if (id === undefined) {
        return Array.from(inMemoryStates.values());
      }
      const state = inMemoryStates.get(id);
      if (!state) throw new Error(`ACP session "${id}" not found`);
      return state;
    },
    getActiveAndPendingIds: () => [
      ...new Set([...inMemoryStates.keys(), ...pendingResumeIds]),
    ],
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
      usageDescription:
        policy?.usageDescription ?? existing?.usageDescription,
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

// Drive the spawn route's high-risk approval gate (ATL-822). `spawnSession`
// registers a `directResolve` confirmation in `pendingInteractions` and then
// broadcasts a `confirmation_request`. Real broadcasting needs the event hub /
// SSE wiring, so the mock auto-resolves the freshly registered interaction
// the same way `POST /v1/confirm` would (resolve + directResolve). Tests flip
// `approvalBehavior` to exercise allow / deny, and read `confirmationRequests`
// to assert the prompt's risk shape. `interaction_resolved` and other event
// types are ignored.
type ApprovalBehavior = "allow" | "deny";
let approvalBehavior: ApprovalBehavior = "allow";
const confirmationRequests: Array<Record<string, unknown>> = [];

mock.module("../../runtime/assistant-event-hub.js", () => ({
  broadcastMessage: (msg: { type?: string; requestId?: string }) => {
    if (msg?.type !== "confirmation_request") return;
    confirmationRequests.push(msg as Record<string, unknown>);
    const decision = approvalBehavior;
    const interaction = pendingInteractions.resolve(
      msg.requestId as string,
      decision === "allow" ? "approved" : "rejected",
    );
    interaction?.directResolve?.(decision);
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
  vaultStore.clear();
  metadataStore.clear();
  approvalBehavior = "allow";
  confirmationRequests.length = 0;
});

// ---------------------------------------------------------------------------
// POST /v1/acp/spawn — failure paths from resolveAcpAgent
// ---------------------------------------------------------------------------

describe("POST /v1/acp/spawn", () => {
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

  test("body-shape guard short-circuits before the resolver runs", async () => {
    const handler = getSpawnHandler();
    await expect(handler({ body: { agent: "claude" } })).rejects.toThrow(
      "agent, task, and conversationId are required",
    );
    // Guard runs before the approval gate — no prompt is surfaced.
    expect(confirmationRequests).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// POST /v1/acp/spawn — high-risk approval gate (ATL-822)
//
// Spawning an ACP agent is a host subprocess with auto-allowed
// filesystem/terminal access. The skill-tool path gets the descriptor's
// `risk: "high"` prompt via ToolExecutor; this route reaches the session
// manager directly, so it surfaces the same confirmation itself and refuses
// to spawn unless a guardian approves.
// ---------------------------------------------------------------------------

describe("POST /v1/acp/spawn — approval gate", () => {
  test("surfaces a high-risk host confirmation before spawning", async () => {
    seedVaultToken("test-token-abc123");

    const handler = getSpawnHandler();
    await handler({
      body: {
        agent: "claude",
        task: "do a thing",
        conversationId: "conv-1",
        cwd: "/work/repo",
      },
    });

    expect(confirmationRequests).toHaveLength(1);
    const prompt = confirmationRequests[0];
    expect(prompt.toolName).toBe("acp_spawn");
    expect(prompt.riskLevel).toBe("high");
    expect(prompt.executionTarget).toBe("host");
    expect(prompt.conversationId).toBe("conv-1");
    expect((prompt.input as { cwd?: string }).cwd).toBe("/work/repo");
    // Prompt resolved "allow" → spawn proceeds.
    expect(capturedSpawns).toHaveLength(1);
  });

  test("throws ForbiddenError and does not spawn when the guardian denies", async () => {
    approvalBehavior = "deny";
    seedVaultToken("test-token-abc123");

    const handler = getSpawnHandler();
    await expect(
      handler({
        body: {
          agent: "claude",
          task: "do a thing",
          conversationId: "conv-1",
        },
      }),
    ).rejects.toThrow(/guardian approval/i);

    // Denied before any host side effects: no subprocess, no pending leak.
    expect(capturedSpawns).toHaveLength(0);
    expect(pendingInteractions.getAll()).toHaveLength(0);
  });

  test("denies (and does not spawn) when the client disconnects before approval", async () => {
    seedVaultToken("test-token-abc123");
    const controller = new AbortController();
    controller.abort();

    const handler = getSpawnHandler();
    await expect(
      handler({
        body: {
          agent: "claude",
          task: "do a thing",
          conversationId: "conv-1",
        },
        abortSignal: controller.signal,
      }),
    ).rejects.toThrow(/guardian approval/i);

    expect(capturedSpawns).toHaveLength(0);
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
    inMemoryStates.clear();
    pendingResumeIds.clear();
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

  test("excludes terminal rows whose session is active in memory (resumed sessions)", async () => {
    // A resumed session reuses its original id: the in-memory state is
    // `running` while its history row still carries the old terminal
    // status until the next terminal upsert. The bulk delete must not
    // remove that row out from under the live session.
    seedHistoryRow("row-resumed", "completed", 1000);
    seedHistoryRow("row-completed", "completed", 2000);
    inMemoryStates.set("row-resumed", {
      id: "row-resumed",
      agentId: "claude",
      acpSessionId: "proto-resumed",
      parentConversationId: "conv-test",
      status: "running",
      startedAt: 1000,
    });

    const handler = getBulkDeleteHandler();
    const result = (await handler({
      queryParams: { status: "completed" },
    })) as {
      deleted: number;
    };
    expect(result.deleted).toBe(1);

    const remaining = listRows();
    expect(remaining).toEqual([{ id: "row-resumed", status: "completed" }]);
  });

  test("excludes terminal rows whose session has a resume in flight", async () => {
    // A resume that is still awaiting env preparation has no in-memory
    // SessionEntry yet, but its history row (still terminal) must survive:
    // deleting it mid-resume would let the later terminal upsert resurrect
    // it as an orphan row.
    seedHistoryRow("row-pending-resume", "completed", 1000);
    seedHistoryRow("row-completed", "completed", 2000);
    pendingResumeIds.add("row-pending-resume");

    const handler = getBulkDeleteHandler();
    const result = (await handler({
      queryParams: { status: "completed" },
    })) as {
      deleted: number;
    };
    expect(result.deleted).toBe(1);

    const remaining = listRows();
    expect(remaining).toEqual([
      { id: "row-pending-resume", status: "completed" },
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
    pendingResumeIds.clear();
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

  test("returns 409 when the session has a resume in flight (not yet in memory)", async () => {
    pendingResumeIds.add("sess-resuming");
    insertHistoryRow({ id: "sess-resuming", status: "completed" });

    const handler = getDeleteSessionHandler();
    expect(() => handler({ pathParams: { id: "sess-resuming" } })).toThrow(
      "resume in flight",
    );

    // Row untouched.
    const remaining = getDb()
      .select()
      .from(acpSessionHistory)
      .where(eq(acpSessionHistory.id, "sess-resuming"))
      .all();
    expect(remaining).toHaveLength(1);
  });

  test("idempotent for unknown id — returns { deleted: false }", async () => {
    const handler = getDeleteSessionHandler();
    const result = (await handler({
      pathParams: { id: "does-not-exist" },
    })) as { deleted: boolean };
    expect(result.deleted).toBe(false);
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
