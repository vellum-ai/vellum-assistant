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
const previousBaseDataDir = process.env.BASE_DATA_DIR;
process.env.BASE_DATA_DIR = testDir;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const realPlatform = require("../util/platform.js");
mock.module("../util/platform.js", () => ({
  ...realPlatform,
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

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  trace: () => {},
  fatal: () => {},
  child: () => noopLogger,
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const realLogger = require("../util/logger.js");
mock.module("../util/logger.js", () => ({
  ...realLogger,
  getLogger: () => noopLogger,
  getCliLogger: () => noopLogger,
  isDebug: () => false,
  truncateForLog: (value: string) => value,
  initLogger: () => {},
  pruneOldLogFiles: () => 0,
}));

// Bypass HTTP auth so requireBoundGuardian does not reject the test principal.
mock.module("../config/env.js", () => ({ isHttpAuthDisabled: () => true }));

// Prevent the IPC handler's resolveLocalIpcTrustContext from creating a real
// guardian binding via ensureVellumGuardianBinding. Return a stable trust
// context that the IPC handler tests can assert against.
mock.module("../runtime/guardian-vellum-migration.js", () => ({
  ensureVellumGuardianBinding: () => "test-principal",
}));
mock.module("../runtime/local-actor-identity.js", () => ({
  resolveLocalIpcTrustContext: () => ({
    trustClass: "guardian" as const,
    sourceChannel: "vellum",
    guardianExternalUserId: "test-principal",
    guardianPrincipalId: "test-principal",
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
  createCanonicalGuardianDelivery,
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

resetDb();
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
  db.run("DELETE FROM canonical_guardian_deliveries");
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
  if (previousBaseDataDir === undefined) {
    delete process.env.BASE_DATA_DIR;
  } else {
    process.env.BASE_DATA_DIR = previousBaseDataDir;
  }
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
  beforeEach(() => {
    resetDb();
    initializeDb();
    resetTables();
  });

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

  test("allows decision when conversationId matches a delivery destination", async () => {
    createTestCanonicalRequest({
      conversationId: "conv-source-http",
      requestId: "req-dest-scope-http",
      kind: "pending_question",
    });
    createCanonicalGuardianDelivery({
      requestId: "req-dest-scope-http",
      destinationChannel: "vellum",
      destinationConversationId: "conv-guardian-thread",
    });
    mockApplyCanonicalGuardianDecision.mockResolvedValueOnce({
      applied: true,
      requestId: "req-dest-scope-http",
      grantMinted: false,
    });

    const req = new Request("http://localhost/v1/guardian-actions/decision", {
      method: "POST",
      body: JSON.stringify({
        requestId: "req-dest-scope-http",
        action: "approve_once",
        conversationId: "conv-guardian-thread",
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
  beforeEach(() => {
    resetDb();
    initializeDb();
    resetTables();
  });

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
  beforeEach(() => {
    resetDb();
    initializeDb();
    resetTables();
  });

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
    // buildKindAwareQuestionText appends request-code fallback instructions
    // for access_request kind, so use partial matching
    expect(prompts[0].questionText).toContain("User wants access");
    expect(prompts[0].questionText).toContain("approve");
    expect(prompts[0].questionText).toContain("reject");
    expect(prompts[0].questionText).toContain("open invite flow");
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

  test("includes requests delivered to the queried destination conversation", () => {
    createTestCanonicalRequest({
      conversationId: "conv-source",
      requestId: "req-dest-1",
      kind: "pending_question",
      questionText: "What should I do?",
    });
    createCanonicalGuardianDelivery({
      requestId: "req-dest-1",
      destinationChannel: "vellum",
      destinationConversationId: "conv-guardian-dest",
    });

    const prompts = listGuardianDecisionPrompts({
      conversationId: "conv-guardian-dest",
    });
    expect(prompts).toHaveLength(1);
    expect(prompts[0].requestId).toBe("req-dest-1");
    expect(prompts[0].questionText).toBe("What should I do?");
  });

  test("normalizes prompt conversationId to the queried thread ID", () => {
    createTestCanonicalRequest({
      conversationId: "conv-source-norm",
      requestId: "req-norm-1",
      kind: "access_request",
      questionText: "Grant access?",
    });
    createCanonicalGuardianDelivery({
      requestId: "req-norm-1",
      destinationChannel: "vellum",
      destinationConversationId: "conv-dest-norm",
    });

    const prompts = listGuardianDecisionPrompts({
      conversationId: "conv-dest-norm",
    });
    expect(prompts).toHaveLength(1);
    // conversationId should be normalized to the queried thread, not the source
    expect(prompts[0].conversationId).toBe("conv-dest-norm");
  });

  test("deduplicates requests found by both source and destination", () => {
    createTestCanonicalRequest({
      conversationId: "conv-same",
      requestId: "req-dedup-1",
    });
    // Deliver to the same conversation (source == destination)
    createCanonicalGuardianDelivery({
      requestId: "req-dedup-1",
      destinationChannel: "vellum",
      destinationConversationId: "conv-same",
    });

    const prompts = listGuardianDecisionPrompts({
      conversationId: "conv-same",
    });
    expect(prompts).toHaveLength(1);
    expect(prompts[0].requestId).toBe("req-dedup-1");
  });
});

// =========================================================================
// IPC handler: guardian_action_decision
// =========================================================================

describe("IPC guardian_action_decision", () => {
  beforeEach(() => {
    resetDb();
    initializeDb();
    resetTables();
  });

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

  test("allows decision when conversationId matches a delivery destination", async () => {
    createTestCanonicalRequest({
      conversationId: "conv-ipc-source",
      requestId: "req-ipc-dest-scope",
      kind: "pending_question",
    });
    createCanonicalGuardianDelivery({
      requestId: "req-ipc-dest-scope",
      destinationChannel: "vellum",
      destinationConversationId: "conv-ipc-guardian-thread",
    });
    mockApplyCanonicalGuardianDecision.mockResolvedValueOnce({
      applied: true,
      requestId: "req-ipc-dest-scope",
      grantMinted: false,
    });

    const { socket, ctx, sent } = createIpcStub();
    await handler(
      {
        type: "guardian_action_decision",
        requestId: "req-ipc-dest-scope",
        action: "approve_once",
        conversationId: "conv-ipc-guardian-thread",
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
  beforeEach(() => {
    resetDb();
    initializeDb();
    resetTables();
  });

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

  test("returns prompts delivered to the queried destination conversation", () => {
    createTestCanonicalRequest({
      conversationId: "conv-ipc-source-list",
      requestId: "req-ipc-dest-list",
      kind: "pending_question",
      questionText: "Voice question?",
    });
    createCanonicalGuardianDelivery({
      requestId: "req-ipc-dest-list",
      destinationChannel: "vellum",
      destinationConversationId: "conv-ipc-dest-list",
    });

    const { socket, ctx, sent } = createIpcStub();
    handler(
      {
        type: "guardian_actions_pending_request",
        conversationId: "conv-ipc-dest-list",
      } as any,
      socket as any,
      ctx as any,
    );
    expect(sent).toHaveLength(1);
    const prompts = sent[0].prompts as Array<{
      requestId: string;
      questionText: string;
      conversationId: string;
    }>;
    expect(prompts).toHaveLength(1);
    expect(prompts[0].requestId).toBe("req-ipc-dest-list");
    expect(prompts[0].questionText).toBe("Voice question?");
    expect(prompts[0].conversationId).toBe("conv-ipc-dest-list");
  });
});

// =========================================================================
// Integration: pending_question visible/actionable in guardian thread
// =========================================================================

describe("integration: pending_question visible and actionable in guardian thread", () => {
  beforeEach(() => {
    resetDb();
    initializeDb();
    resetTables();
  });

  test("pending_question delivered to guardian thread is visible via pending endpoint", () => {
    createTestCanonicalRequest({
      conversationId: "conv-voice-source",
      requestId: "req-pq-visible-1",
      kind: "pending_question",
      questionText: "What time works best for the appointment?",
    });
    createCanonicalGuardianDelivery({
      requestId: "req-pq-visible-1",
      destinationChannel: "vellum",
      destinationConversationId: "conv-guardian-macos",
    });

    const prompts = listGuardianDecisionPrompts({
      conversationId: "conv-guardian-macos",
    });
    expect(prompts).toHaveLength(1);
    expect(prompts[0].requestId).toBe("req-pq-visible-1");
    expect(prompts[0].kind).toBe("pending_question");
    expect(prompts[0].questionText).toBe(
      "What time works best for the appointment?",
    );
    expect(prompts[0].conversationId).toBe("conv-guardian-macos");
  });

  test("pending_question prompt has approve/reject actions (guardian-on-behalf)", () => {
    createTestCanonicalRequest({
      conversationId: "conv-voice-src-2",
      requestId: "req-pq-actions-1",
      kind: "pending_question",
      questionText: "Should I confirm the meeting?",
    });

    const prompts = listGuardianDecisionPrompts({
      conversationId: "conv-voice-src-2",
    });
    expect(prompts).toHaveLength(1);
    const actions = prompts[0].actions.map((a: { action: string }) => a.action);
    expect(actions).toContain("approve_once");
    expect(actions).toContain("reject");
    // Guardian-on-behalf: no approve_always or temporary modes
    expect(actions).not.toContain("approve_always");
    expect(actions).not.toContain("approve_10m");
    expect(actions).not.toContain("approve_thread");
  });

  test("pending_question is actionable via HTTP decision endpoint", async () => {
    createTestCanonicalRequest({
      conversationId: "conv-voice-src-3",
      requestId: "req-pq-action-http",
      kind: "pending_question",
      questionText: "Allow email to bob@example.com?",
      toolName: "send_email",
    });
    createCanonicalGuardianDelivery({
      requestId: "req-pq-action-http",
      destinationChannel: "vellum",
      destinationConversationId: "conv-guardian-thread-pq",
    });

    mockApplyCanonicalGuardianDecision.mockResolvedValueOnce({
      applied: true,
      requestId: "req-pq-action-http",
      grantMinted: false,
    });

    const req = new Request("http://localhost/v1/guardian-actions/decision", {
      method: "POST",
      body: JSON.stringify({
        requestId: "req-pq-action-http",
        action: "approve_once",
        conversationId: "conv-guardian-thread-pq",
      }),
    });
    const res = await handleGuardianActionDecision(req, mockAuthContext);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.applied).toBe(true);
    expect(mockApplyCanonicalGuardianDecision).toHaveBeenCalledTimes(1);
  });
});

// =========================================================================
// Integration: access_request visible/actionable in guardian thread
// =========================================================================

describe("integration: access_request visible and actionable in guardian thread", () => {
  beforeEach(() => {
    resetDb();
    initializeDb();
    resetTables();
  });

  test("access_request delivered to guardian thread is visible via pending endpoint", () => {
    createTestCanonicalRequest({
      conversationId: "conv-access-src-1",
      requestId: "req-ar-visible-1",
      kind: "access_request",
      toolName: "ingress_access_request",
      questionText: "Alice via Telegram is requesting access to the assistant",
    });
    createCanonicalGuardianDelivery({
      requestId: "req-ar-visible-1",
      destinationChannel: "vellum",
      destinationConversationId: "conv-guardian-macos-ar",
    });

    const prompts = listGuardianDecisionPrompts({
      conversationId: "conv-guardian-macos-ar",
    });
    expect(prompts).toHaveLength(1);
    expect(prompts[0].requestId).toBe("req-ar-visible-1");
    expect(prompts[0].kind).toBe("access_request");
    expect(prompts[0].conversationId).toBe("conv-guardian-macos-ar");
  });

  test("access_request prompt includes text fallback instructions with request code", () => {
    createTestCanonicalRequest({
      conversationId: "conv-access-src-2",
      requestId: "req-ar-fallback-1",
      kind: "access_request",
      toolName: "ingress_access_request",
      questionText: "Bob via WhatsApp is requesting access to the assistant",
    });

    const prompts = listGuardianDecisionPrompts({
      conversationId: "conv-access-src-2",
    });
    expect(prompts).toHaveLength(1);
    const qt = prompts[0].questionText;
    // Must contain original question text
    expect(qt).toContain(
      "Bob via WhatsApp is requesting access to the assistant",
    );
    // Must contain request-code-based approve/reject directive
    expect(qt).toContain("approve");
    expect(qt).toContain("reject");
    // Must contain invite flow directive
    expect(qt).toContain("open invite flow");
  });

  test("access_request prompt has approve/reject actions (guardian-on-behalf)", () => {
    createTestCanonicalRequest({
      conversationId: "conv-access-src-3",
      requestId: "req-ar-actions-1",
      kind: "access_request",
      toolName: "ingress_access_request",
      questionText: "Carol is requesting access",
    });

    const prompts = listGuardianDecisionPrompts({
      conversationId: "conv-access-src-3",
    });
    expect(prompts).toHaveLength(1);
    const actions = prompts[0].actions.map((a: { action: string }) => a.action);
    expect(actions).toContain("approve_once");
    expect(actions).toContain("reject");
    expect(actions).not.toContain("approve_always");
  });

  test("access_request is actionable via HTTP decision endpoint from guardian thread", async () => {
    createTestCanonicalRequest({
      conversationId: "conv-access-src-4",
      requestId: "req-ar-action-http",
      kind: "access_request",
      toolName: "ingress_access_request",
      guardianExternalUserId: "guardian-88",
    });
    createCanonicalGuardianDelivery({
      requestId: "req-ar-action-http",
      destinationChannel: "vellum",
      destinationConversationId: "conv-guardian-thread-ar",
    });

    mockApplyCanonicalGuardianDecision.mockResolvedValueOnce({
      applied: true,
      requestId: "req-ar-action-http",
      grantMinted: false,
    });

    const req = new Request("http://localhost/v1/guardian-actions/decision", {
      method: "POST",
      body: JSON.stringify({
        requestId: "req-ar-action-http",
        action: "approve_once",
        conversationId: "conv-guardian-thread-ar",
      }),
    });
    const res = await handleGuardianActionDecision(req, mockAuthContext);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.applied).toBe(true);
    expect(mockApplyCanonicalGuardianDecision).toHaveBeenCalledTimes(1);
  });

  test("access_request reject is actionable via HTTP decision endpoint", async () => {
    createTestCanonicalRequest({
      conversationId: "conv-access-src-5",
      requestId: "req-ar-reject-http",
      kind: "access_request",
      toolName: "ingress_access_request",
    });

    mockApplyCanonicalGuardianDecision.mockResolvedValueOnce({
      applied: true,
      requestId: "req-ar-reject-http",
      grantMinted: false,
    });

    const req = new Request("http://localhost/v1/guardian-actions/decision", {
      method: "POST",
      body: JSON.stringify({
        requestId: "req-ar-reject-http",
        action: "reject",
      }),
    });
    const res = await handleGuardianActionDecision(req, mockAuthContext);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.applied).toBe(true);
  });
});

// =========================================================================
// Integration: text/code fallback routing when buttons are not used
// =========================================================================

describe("integration: text/code fallback routing remains functional", () => {
  beforeEach(() => {
    resetDb();
    initializeDb();
    resetTables();
  });

  test("requestCode is always present in prompt for text-based fallback", () => {
    createTestCanonicalRequest({
      conversationId: "conv-fallback-1",
      requestId: "req-fallback-code-1",
      kind: "tool_approval",
      toolName: "bash",
      questionText: "Run bash: rm -rf /tmp/test",
    });

    const prompts = listGuardianDecisionPrompts({
      conversationId: "conv-fallback-1",
    });
    expect(prompts).toHaveLength(1);
    // requestCode must be a non-empty string for text-based fallback
    expect(prompts[0].requestCode).toBeTruthy();
    expect(prompts[0].requestCode.length).toBeGreaterThanOrEqual(6);
  });

  test("pending_question prompt includes requestCode for text fallback", () => {
    createTestCanonicalRequest({
      conversationId: "conv-fallback-pq",
      requestId: "req-fallback-pq-1",
      kind: "pending_question",
      questionText: "When should I schedule the delivery?",
    });

    const prompts = listGuardianDecisionPrompts({
      conversationId: "conv-fallback-pq",
    });
    expect(prompts).toHaveLength(1);
    expect(prompts[0].requestCode).toBeTruthy();
    expect(prompts[0].kind).toBe("pending_question");
  });

  test("access_request prompt includes requestCode and text directives for fallback", () => {
    createTestCanonicalRequest({
      conversationId: "conv-fallback-ar",
      requestId: "req-fallback-ar-1",
      kind: "access_request",
      toolName: "ingress_access_request",
      questionText: "Dave is requesting access",
    });

    const prompts = listGuardianDecisionPrompts({
      conversationId: "conv-fallback-ar",
    });
    expect(prompts).toHaveLength(1);
    const prompt = prompts[0];
    // requestCode present for code-based text fallback
    expect(prompt.requestCode).toBeTruthy();
    // questionText includes explicit text fallback instructions
    const code = prompt.requestCode;
    expect(prompt.questionText).toContain(`"${code} approve"`);
    expect(prompt.questionText).toContain(`"${code} reject"`);
    expect(prompt.questionText).toContain('"open invite flow"');
  });

  test("mixed pending_question and access_request visible in same guardian thread", () => {
    // Create a pending_question delivered to guardian thread
    createTestCanonicalRequest({
      conversationId: "conv-src-mixed-1",
      requestId: "req-mixed-pq",
      kind: "pending_question",
      questionText: "What time works?",
    });
    createCanonicalGuardianDelivery({
      requestId: "req-mixed-pq",
      destinationChannel: "vellum",
      destinationConversationId: "conv-guardian-mixed",
    });

    // Create an access_request delivered to same guardian thread
    createTestCanonicalRequest({
      conversationId: "conv-src-mixed-2",
      requestId: "req-mixed-ar",
      kind: "access_request",
      toolName: "ingress_access_request",
      questionText: "Eve is requesting access",
    });
    createCanonicalGuardianDelivery({
      requestId: "req-mixed-ar",
      destinationChannel: "vellum",
      destinationConversationId: "conv-guardian-mixed",
    });

    const prompts = listGuardianDecisionPrompts({
      conversationId: "conv-guardian-mixed",
    });
    expect(prompts).toHaveLength(2);
    const kinds = prompts.map((p: { kind?: string }) => p.kind).sort();
    expect(kinds).toEqual(["access_request", "pending_question"]);

    // Both prompts have requestCodes for text fallback
    for (const prompt of prompts) {
      expect(prompt.requestCode).toBeTruthy();
      expect(prompt.actions.length).toBeGreaterThan(0);
    }
  });

  test("stale access_request decision returns reason without regression", async () => {
    createTestCanonicalRequest({
      conversationId: "conv-stale-ar",
      requestId: "req-stale-ar-1",
      kind: "access_request",
      toolName: "ingress_access_request",
    });
    mockApplyCanonicalGuardianDecision.mockResolvedValueOnce({
      applied: false,
      reason: "already_resolved",
    });

    const req = new Request("http://localhost/v1/guardian-actions/decision", {
      method: "POST",
      body: JSON.stringify({
        requestId: "req-stale-ar-1",
        action: "approve_once",
      }),
    });
    const res = await handleGuardianActionDecision(req, mockAuthContext);
    const body = await res.json();
    expect(body.applied).toBe(false);
    expect(body.reason).toBe("already_resolved");
    expect(body.requestId).toBe("req-stale-ar-1");
  });
});
