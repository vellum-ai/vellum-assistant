/**
 * Tests for the deterministic guardian action endpoints:
 * - HTTP route handlers (guardian-action-routes.ts)
 * - IPC handlers (guardian-actions.ts)
 *
 * Covers: conversationId scoping, stale handling, access-request routing,
 * invalid action rejection, and not-found paths.
 *
 * All decisions now go through the canonical guardian decision primitive
 * (`applyCanonicalGuardianDecision`), so tests create canonical requests
 * and mock that function.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

const testDir = mkdtempSync(join(tmpdir(), "guardian-actions-endpoint-test-"));

mock.module("../util/platform.js", () => ({
  getDataDir: () => testDir,
  isMacOS: () => process.platform === "darwin",
  isLinux: () => process.platform === "linux",
  isWindows: () => process.platform === "win32",
  getSocketPath: () => join(testDir, "test.sock"),
  getPidPath: () => join(testDir, "test.pid"),
  getDbPath: () => join(testDir, "test.db"),
  getLogPath: () => join(testDir, "test.log"),
  ensureDataDir: () => {},
}));

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// Mock applyCanonicalGuardianDecision — the single decision write path.
const mockApplyCanonicalGuardianDecision = mock(
  (
    ..._args: any[]
  ): Promise<{
    applied: boolean;
    requestId?: string;
    reason?: string;
    grantMinted?: boolean;
  }> =>
    Promise.resolve({
      applied: true,
      requestId: "req-123",
      grantMinted: false,
    }),
);
mock.module("../approvals/guardian-decision-primitive.js", () => ({
  applyCanonicalGuardianDecision: mockApplyCanonicalGuardianDecision,
}));

import { guardianActionsHandlers } from "../daemon/handlers/guardian-actions.js";
import {
  createCanonicalGuardianRequest,
  generateCanonicalRequestCode,
} from "../memory/canonical-guardian-store.js";
import { initializeDb, resetDb } from "../memory/db.js";
import { getDb } from "../memory/db.js";
import { conversations } from "../memory/schema.js";
import type { AuthContext } from "../runtime/auth/types.js";
import {
  handleGuardianActionDecision,
  handleGuardianActionsPending,
  listGuardianDecisionPrompts,
} from "../runtime/routes/guardian-action-routes.js";

/** Synthetic AuthContext for tests -- mimics a local actor with full scopes. */
const mockAuthContext: AuthContext = {
  subject: "actor:self:test-principal",
  principalType: "actor",
  assistantId: "self",
  actorPrincipalId: "test-principal",
  scopeProfile: "actor_client_v1",
  scopes: new Set([
    "chat.read",
    "chat.write",
    "approval.read",
    "approval.write",
  ]),
  policyEpoch: 1,
};

initializeDb();

function ensureConversation(id: string): void {
  const db = getDb();
  const now = Date.now();
  db.insert(conversations)
    .values({ id, title: `Conversation ${id}`, createdAt: now, updatedAt: now })
    .run();
}

function resetTables(): void {
  const db = getDb();
  db.run("DELETE FROM canonical_guardian_requests");
  db.run("DELETE FROM channel_guardian_approval_requests");
  db.run("DELETE FROM conversations");
  mockApplyCanonicalGuardianDecision.mockClear();
}

/** Create a canonical guardian request for testing. */
function createTestCanonicalRequest(overrides: {
  conversationId: string;
  requestId: string;
  kind?: string;
  toolName?: string;
  guardianExternalUserId?: string;
  guardianPrincipalId?: string;
  questionText?: string;
  expiresAt?: string;
}) {
  ensureConversation(overrides.conversationId);
  return createCanonicalGuardianRequest({
    id: overrides.requestId,
    kind: overrides.kind ?? "tool_approval",
    sourceType: "desktop",
    sourceChannel: "vellum",
    conversationId: overrides.conversationId,
    guardianExternalUserId: overrides.guardianExternalUserId,
    guardianPrincipalId: overrides.guardianPrincipalId ?? "test-principal",
    toolName: overrides.toolName ?? "bash",
    questionText: overrides.questionText,
    requestCode: generateCanonicalRequestCode(),
    status: "pending",
    expiresAt:
      overrides.expiresAt ?? new Date(Date.now() + 60_000).toISOString(),
  });
}

// -- IPC helper ---------------------------------------------------------------

/** Minimal stub for IPC socket and context to capture sent messages. */
function createIpcStub() {
  const sent: Array<Record<string, unknown>> = [];
  const socket = {} as unknown; // opaque -- the handler just passes it through
  const ctx = {
    send: (_socket: unknown, msg: Record<string, unknown>) => {
      sent.push(msg);
    },
  };
  return { socket, ctx, sent };
}

// -- Cleanup ------------------------------------------------------------------

afterAll(() => {
  resetDb();
  try {
    rmSync(testDir, { recursive: true });
  } catch {
    // best-effort
  }
});

// =========================================================================
// HTTP route: handleGuardianActionDecision
// =========================================================================

describe("HTTP handleGuardianActionDecision", () => {
  beforeEach(resetTables);

  test("rejects missing requestId", async () => {
    const req = new Request("http://localhost/v1/guardian-actions/decision", {
      method: "POST",
      body: JSON.stringify({ action: "approve_once" }),
    });
    const res = await handleGuardianActionDecision(req, mockAuthContext);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toContain("requestId");
  });

  test("rejects missing action", async () => {
    const req = new Request("http://localhost/v1/guardian-actions/decision", {
      method: "POST",
      body: JSON.stringify({ requestId: "req-1" }),
    });
    const res = await handleGuardianActionDecision(req, mockAuthContext);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toContain("action");
  });

  test("rejects invalid action", async () => {
    const req = new Request("http://localhost/v1/guardian-actions/decision", {
      method: "POST",
      body: JSON.stringify({ requestId: "req-1", action: "nuke_from_orbit" }),
    });
    const res = await handleGuardianActionDecision(req, mockAuthContext);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toContain("Invalid action");
  });

  test("returns 404 when no canonical request exists (not_found from canonical primitive)", async () => {
    mockApplyCanonicalGuardianDecision.mockResolvedValueOnce({
      applied: false,
      reason: "not_found",
    });

    const req = new Request("http://localhost/v1/guardian-actions/decision", {
      method: "POST",
      body: JSON.stringify({
        requestId: "nonexistent",
        action: "approve_once",
      }),
    });
    const res = await handleGuardianActionDecision(req, mockAuthContext);
    expect(res.status).toBe(404);
  });

  test("applies decision via applyCanonicalGuardianDecision for tool approval", async () => {
    createTestCanonicalRequest({
      conversationId: "conv-1",
      requestId: "req-gd-1",
    });
    mockApplyCanonicalGuardianDecision.mockResolvedValueOnce({
      applied: true,
      requestId: "req-gd-1",
      grantMinted: false,
    });

    const req = new Request("http://localhost/v1/guardian-actions/decision", {
      method: "POST",
      body: JSON.stringify({ requestId: "req-gd-1", action: "approve_once" }),
    });
    const res = await handleGuardianActionDecision(req, mockAuthContext);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.applied).toBe(true);
    expect(body.requestId).toBe("req-gd-1");
    expect(mockApplyCanonicalGuardianDecision).toHaveBeenCalledTimes(1);
  });

  test("rejects decision when conversationId does not match canonical request", async () => {
    createTestCanonicalRequest({
      conversationId: "conv-1",
      requestId: "req-scope-1",
    });

    const req = new Request("http://localhost/v1/guardian-actions/decision", {
      method: "POST",
      body: JSON.stringify({
        requestId: "req-scope-1",
        action: "approve_once",
        conversationId: "conv-wrong",
      }),
    });
    const res = await handleGuardianActionDecision(req, mockAuthContext);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.message).toContain("No pending guardian action");
    expect(mockApplyCanonicalGuardianDecision).not.toHaveBeenCalled();
  });

  test("allows decision when conversationId matches canonical request", async () => {
    createTestCanonicalRequest({
      conversationId: "conv-match",
      requestId: "req-scope-2",
    });
    mockApplyCanonicalGuardianDecision.mockResolvedValueOnce({
      applied: true,
      requestId: "req-scope-2",
      grantMinted: false,
    });

    const req = new Request("http://localhost/v1/guardian-actions/decision", {
      method: "POST",
      body: JSON.stringify({
        requestId: "req-scope-2",
        action: "reject",
        conversationId: "conv-match",
      }),
    });
    const res = await handleGuardianActionDecision(req, mockAuthContext);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.applied).toBe(true);
  });

  test("allows decision when no conversationId is provided (backward compat)", async () => {
    createTestCanonicalRequest({
      conversationId: "conv-any",
      requestId: "req-scope-3",
    });
    mockApplyCanonicalGuardianDecision.mockResolvedValueOnce({
      applied: true,
      requestId: "req-scope-3",
      grantMinted: false,
    });

    const req = new Request("http://localhost/v1/guardian-actions/decision", {
      method: "POST",
      body: JSON.stringify({
        requestId: "req-scope-3",
        action: "approve_once",
      }),
    });
    const res = await handleGuardianActionDecision(req, mockAuthContext);
    expect(res.status).toBe(200);
  });

  test("applies decision for access_request kind through canonical primitive", async () => {
    createTestCanonicalRequest({
      conversationId: "conv-access",
      requestId: "req-access-1",
      kind: "access_request",
      toolName: "ingress_access_request",
      guardianExternalUserId: "guardian-42",
    });
    mockApplyCanonicalGuardianDecision.mockResolvedValueOnce({
      applied: true,
      requestId: "req-access-1",
      grantMinted: false,
    });

    const req = new Request("http://localhost/v1/guardian-actions/decision", {
      method: "POST",
      body: JSON.stringify({
        requestId: "req-access-1",
        action: "approve_once",
      }),
    });
    const res = await handleGuardianActionDecision(req, mockAuthContext);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.applied).toBe(true);
    // All decisions go through the canonical primitive
    expect(mockApplyCanonicalGuardianDecision).toHaveBeenCalledTimes(1);
  });

  test("applies decision for voice access_request kind through canonical primitive", async () => {
    createTestCanonicalRequest({
      conversationId: "conv-voice-access",
      requestId: "req-voice-access-1",
      kind: "access_request",
      toolName: "ingress_access_request",
      guardianExternalUserId: "guardian-voice-42",
    });
    mockApplyCanonicalGuardianDecision.mockResolvedValueOnce({
      applied: true,
      requestId: "req-voice-access-1",
      grantMinted: false,
    });

    const req = new Request("http://localhost/v1/guardian-actions/decision", {
      method: "POST",
      body: JSON.stringify({
        requestId: "req-voice-access-1",
        action: "approve_once",
      }),
    });
    const res = await handleGuardianActionDecision(req, mockAuthContext);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.applied).toBe(true);
    expect(mockApplyCanonicalGuardianDecision).toHaveBeenCalledTimes(1);
  });

  test("returns stale reason from canonical decision primitive", async () => {
    createTestCanonicalRequest({
      conversationId: "conv-stale",
      requestId: "req-stale-1",
    });
    mockApplyCanonicalGuardianDecision.mockResolvedValueOnce({
      applied: false,
      reason: "already_resolved",
    });

    const req = new Request("http://localhost/v1/guardian-actions/decision", {
      method: "POST",
      body: JSON.stringify({
        requestId: "req-stale-1",
        action: "approve_once",
      }),
    });
    const res = await handleGuardianActionDecision(req, mockAuthContext);
    const body = await res.json();
    expect(body.applied).toBe(false);
    expect(body.reason).toBe("already_resolved");
    // requestId should fall back to the original request ID
    expect(body.requestId).toBe("req-stale-1");
  });

  test("passes actorContext with vellum channel and guardianPrincipalId", async () => {
    createTestCanonicalRequest({
      conversationId: "conv-actor",
      requestId: "req-actor-1",
    });
    mockApplyCanonicalGuardianDecision.mockResolvedValueOnce({
      applied: true,
      requestId: "req-actor-1",
      grantMinted: false,
    });

    const req = new Request("http://localhost/v1/guardian-actions/decision", {
      method: "POST",
      body: JSON.stringify({
        requestId: "req-actor-1",
        action: "approve_once",
      }),
    });
    await handleGuardianActionDecision(req, mockAuthContext);
    const call = mockApplyCanonicalGuardianDecision.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    const actorContext = call.actorContext as Record<string, unknown>;
    expect(actorContext.channel).toBe("vellum");
    expect(actorContext.guardianPrincipalId).toBeDefined();
  });
});

// =========================================================================
// HTTP route: handleGuardianActionsPending
// =========================================================================

describe("HTTP handleGuardianActionsPending", () => {
  beforeEach(resetTables);

  test("returns 400 when conversationId is missing", () => {
    const url = new URL("http://localhost/v1/guardian-actions/pending");
    const res = handleGuardianActionsPending(url, mockAuthContext);
    expect(res.status).toBe(400);
  });

  test("returns prompts for a conversation with pending canonical requests", () => {
    createTestCanonicalRequest({
      conversationId: "conv-list",
      requestId: "req-list-1",
      questionText: "Run bash: ls",
    });

    const url = new URL(
      "http://localhost/v1/guardian-actions/pending?conversationId=conv-list",
    );
    const res = handleGuardianActionsPending(url, mockAuthContext);
    expect(res.status).toBe(200);

    // Verify the prompts directly via the shared helper
    const prompts = listGuardianDecisionPrompts({
      conversationId: "conv-list",
    });
    expect(prompts).toHaveLength(1);
    expect(prompts[0].requestId).toBe("req-list-1");
    expect(prompts[0].questionText).toBe("Run bash: ls");
  });

  test("returns empty prompts for a conversation with no pending requests", () => {
    const prompts = listGuardianDecisionPrompts({
      conversationId: "conv-empty",
    });
    expect(prompts).toHaveLength(0);
  });
});

// =========================================================================
// listGuardianDecisionPrompts
// =========================================================================

describe("listGuardianDecisionPrompts", () => {
  beforeEach(resetTables);

  test("excludes expired canonical requests", () => {
    ensureConversation("conv-expired");
    createCanonicalGuardianRequest({
      id: "req-expired",
      kind: "tool_approval",
      sourceType: "desktop",
      sourceChannel: "vellum",
      conversationId: "conv-expired",
      guardianPrincipalId: "test-principal",
      toolName: "bash",
      requestCode: generateCanonicalRequestCode(),
      status: "pending",
      expiresAt: new Date(Date.now() - 1000).toISOString(), // already expired
    });

    const prompts = listGuardianDecisionPrompts({
      conversationId: "conv-expired",
    });
    expect(prompts).toHaveLength(0);
  });

  test("includes pending canonical requests with toolName", () => {
    createTestCanonicalRequest({
      conversationId: "conv-tool",
      requestId: "req-tool-prompt",
      toolName: "read_file",
    });

    const prompts = listGuardianDecisionPrompts({
      conversationId: "conv-tool",
    });
    expect(prompts).toHaveLength(1);
    expect(prompts[0].toolName).toBe("read_file");
    expect(prompts[0].requestId).toBe("req-tool-prompt");
  });

  test("generates questionText from toolName when questionText is not set", () => {
    createTestCanonicalRequest({
      conversationId: "conv-gen-qt",
      requestId: "req-gen-qt",
      toolName: "bash",
    });

    const prompts = listGuardianDecisionPrompts({
      conversationId: "conv-gen-qt",
    });
    expect(prompts).toHaveLength(1);
    expect(prompts[0].questionText).toBe("Approve tool: bash");
  });

  test("uses questionText when it is set", () => {
    createTestCanonicalRequest({
      conversationId: "conv-qt",
      requestId: "req-qt",
      toolName: "bash",
      questionText: "Run bash: ls -la",
    });

    const prompts = listGuardianDecisionPrompts({ conversationId: "conv-qt" });
    expect(prompts).toHaveLength(1);
    expect(prompts[0].questionText).toBe("Run bash: ls -la");
  });

  test("returns prompt with correct shape fields", () => {
    createTestCanonicalRequest({
      conversationId: "conv-shape",
      requestId: "req-shape",
      toolName: "bash",
      questionText: "Test prompt",
    });

    const prompts = listGuardianDecisionPrompts({
      conversationId: "conv-shape",
    });
    expect(prompts).toHaveLength(1);
    const prompt = prompts[0];
    expect(prompt.requestId).toBe("req-shape");
    expect(prompt.state).toBe("pending");
    expect(prompt.conversationId).toBe("conv-shape");
    expect(prompt.toolName).toBe("bash");
    expect(prompt.actions).toBeDefined();
    expect(prompt.expiresAt).toBeGreaterThan(Date.now() - 5000);
    expect(prompt.kind).toBe("tool_approval");
  });

  test("includes access_request kind canonical requests", () => {
    createTestCanonicalRequest({
      conversationId: "conv-ar-prompt",
      requestId: "req-ar-prompt",
      kind: "access_request",
      toolName: "ingress_access_request",
      questionText: "User wants access",
    });

    const prompts = listGuardianDecisionPrompts({
      conversationId: "conv-ar-prompt",
    });
    expect(prompts).toHaveLength(1);
    expect(prompts[0].kind).toBe("access_request");
    expect(prompts[0].questionText).toBe("User wants access");
  });

  test("only returns requests for the given conversationId", () => {
    createTestCanonicalRequest({
      conversationId: "conv-a",
      requestId: "req-a",
    });
    createTestCanonicalRequest({
      conversationId: "conv-b",
      requestId: "req-b",
    });

    const promptsA = listGuardianDecisionPrompts({ conversationId: "conv-a" });
    expect(promptsA).toHaveLength(1);
    expect(promptsA[0].requestId).toBe("req-a");

    const promptsB = listGuardianDecisionPrompts({ conversationId: "conv-b" });
    expect(promptsB).toHaveLength(1);
    expect(promptsB[0].requestId).toBe("req-b");
  });
});

// =========================================================================
// IPC handler: guardian_action_decision
// =========================================================================

describe("IPC guardian_action_decision", () => {
  beforeEach(resetTables);

  const handler = guardianActionsHandlers.guardian_action_decision;

  test("rejects invalid action", async () => {
    const { socket, ctx, sent } = createIpcStub();
    await handler(
      {
        type: "guardian_action_decision",
        requestId: "req-ipc-1",
        action: "self_destruct",
      } as any,
      socket as any,
      ctx as any,
    );
    expect(sent).toHaveLength(1);
    expect(sent[0].applied).toBe(false);
    expect(sent[0].reason).toBe("invalid_action");
    expect(sent[0].requestId).toBe("req-ipc-1");
  });

  test("returns not_found when no canonical request exists", async () => {
    mockApplyCanonicalGuardianDecision.mockResolvedValueOnce({
      applied: false,
      reason: "not_found",
    });

    const { socket, ctx, sent } = createIpcStub();
    await handler(
      {
        type: "guardian_action_decision",
        requestId: "req-ghost",
        action: "approve_once",
      } as any,
      socket as any,
      ctx as any,
    );
    expect(sent).toHaveLength(1);
    expect(sent[0].applied).toBe(false);
    expect(sent[0].reason).toBe("not_found");
  });

  test("applies decision via applyCanonicalGuardianDecision for tool approval", async () => {
    createTestCanonicalRequest({
      conversationId: "conv-ipc-1",
      requestId: "req-ipc-gd",
    });
    mockApplyCanonicalGuardianDecision.mockResolvedValueOnce({
      applied: true,
      requestId: "req-ipc-gd",
      grantMinted: false,
    });

    const { socket, ctx, sent } = createIpcStub();
    await handler(
      {
        type: "guardian_action_decision",
        requestId: "req-ipc-gd",
        action: "approve_once",
      } as any,
      socket as any,
      ctx as any,
    );
    expect(sent).toHaveLength(1);
    expect(sent[0].applied).toBe(true);
    expect(sent[0].requestId).toBe("req-ipc-gd");
    expect(mockApplyCanonicalGuardianDecision).toHaveBeenCalledTimes(1);
  });

  test("rejects decision when conversationId does not match canonical request", async () => {
    createTestCanonicalRequest({
      conversationId: "conv-ipc-correct",
      requestId: "req-ipc-scope",
    });

    const { socket, ctx, sent } = createIpcStub();
    await handler(
      {
        type: "guardian_action_decision",
        requestId: "req-ipc-scope",
        action: "approve_once",
        conversationId: "conv-ipc-wrong",
      } as any,
      socket as any,
      ctx as any,
    );
    expect(sent).toHaveLength(1);
    expect(sent[0].applied).toBe(false);
    expect(sent[0].reason).toBe("not_found");
    expect(mockApplyCanonicalGuardianDecision).not.toHaveBeenCalled();
  });

  test("allows decision when conversationId matches", async () => {
    createTestCanonicalRequest({
      conversationId: "conv-ipc-match",
      requestId: "req-ipc-match",
    });
    mockApplyCanonicalGuardianDecision.mockResolvedValueOnce({
      applied: true,
      requestId: "req-ipc-match",
      grantMinted: false,
    });

    const { socket, ctx, sent } = createIpcStub();
    await handler(
      {
        type: "guardian_action_decision",
        requestId: "req-ipc-match",
        action: "reject",
        conversationId: "conv-ipc-match",
      } as any,
      socket as any,
      ctx as any,
    );
    expect(sent).toHaveLength(1);
    expect(sent[0].applied).toBe(true);
  });

  test("applies decision for access_request kind through canonical primitive", async () => {
    createTestCanonicalRequest({
      conversationId: "conv-ipc-access",
      requestId: "req-ipc-access",
      kind: "access_request",
      toolName: "ingress_access_request",
      guardianExternalUserId: "guardian-99",
    });
    mockApplyCanonicalGuardianDecision.mockResolvedValueOnce({
      applied: true,
      requestId: "req-ipc-access",
      grantMinted: false,
    });

    const { socket, ctx, sent } = createIpcStub();
    await handler(
      {
        type: "guardian_action_decision",
        requestId: "req-ipc-access",
        action: "approve_once",
      } as any,
      socket as any,
      ctx as any,
    );
    expect(sent).toHaveLength(1);
    expect(sent[0].applied).toBe(true);
    expect(mockApplyCanonicalGuardianDecision).toHaveBeenCalledTimes(1);
  });

  test("returns already_resolved for stale canonical request", async () => {
    createTestCanonicalRequest({
      conversationId: "conv-ipc-stale",
      requestId: "req-ipc-stale",
    });
    mockApplyCanonicalGuardianDecision.mockResolvedValueOnce({
      applied: false,
      reason: "already_resolved",
    });

    const { socket, ctx, sent } = createIpcStub();
    await handler(
      {
        type: "guardian_action_decision",
        requestId: "req-ipc-stale",
        action: "approve_once",
      } as any,
      socket as any,
      ctx as any,
    );
    expect(sent).toHaveLength(1);
    expect(sent[0].requestId).toBe("req-ipc-stale");
    expect(sent[0].reason).toBe("already_resolved");
  });

  test("passes actorContext with vellum channel and guardianPrincipalId", async () => {
    createTestCanonicalRequest({
      conversationId: "conv-ipc-actor",
      requestId: "req-ipc-actor",
    });
    mockApplyCanonicalGuardianDecision.mockResolvedValueOnce({
      applied: true,
      requestId: "req-ipc-actor",
      grantMinted: false,
    });

    const { socket, ctx } = createIpcStub();
    await handler(
      {
        type: "guardian_action_decision",
        requestId: "req-ipc-actor",
        action: "approve_once",
      } as any,
      socket as any,
      ctx as any,
    );
    const call = mockApplyCanonicalGuardianDecision.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    const actorContext = call.actorContext as Record<string, unknown>;
    expect(actorContext.channel).toBe("vellum");
    expect(actorContext.guardianPrincipalId).toBeDefined();
  });
});

// =========================================================================
// IPC handler: guardian_actions_pending_request
// =========================================================================

describe("IPC guardian_actions_pending_request", () => {
  beforeEach(resetTables);

  const handler = guardianActionsHandlers.guardian_actions_pending_request;

  test("returns prompts for a conversation", () => {
    createTestCanonicalRequest({
      conversationId: "conv-ipc-list",
      requestId: "req-ipc-list",
      questionText: "Run bash: pwd",
    });

    const { socket, ctx, sent } = createIpcStub();
    handler(
      {
        type: "guardian_actions_pending_request",
        conversationId: "conv-ipc-list",
      } as any,
      socket as any,
      ctx as any,
    );
    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe("guardian_actions_pending_response");
    expect(sent[0].conversationId).toBe("conv-ipc-list");
    const prompts = sent[0].prompts as Array<{
      requestId: string;
      questionText: string;
    }>;
    expect(prompts).toHaveLength(1);
    expect(prompts[0].requestId).toBe("req-ipc-list");
    expect(prompts[0].questionText).toBe("Run bash: pwd");
  });

  test("returns empty prompts for conversation with no pending requests", () => {
    const { socket, ctx, sent } = createIpcStub();
    handler(
      {
        type: "guardian_actions_pending_request",
        conversationId: "conv-empty-ipc",
      } as any,
      socket as any,
      ctx as any,
    );
    expect(sent).toHaveLength(1);
    const prompts = sent[0].prompts as unknown[];
    expect(prompts).toHaveLength(0);
  });
});
