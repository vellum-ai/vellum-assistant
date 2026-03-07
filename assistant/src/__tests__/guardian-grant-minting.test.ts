/**
 * Tests for M3: scoped grant minting on guardian tool-approval decisions.
 *
 * When a guardian approves a tool-approval request (one with toolName + input),
 * the approval interception flow should mint a `tool_signature` scoped grant.
 * Non-tool-approval requests and rejections must NOT mint grants.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";

// ---------------------------------------------------------------------------
// Test isolation: in-memory SQLite via temp directory
// ---------------------------------------------------------------------------

const testDir = mkdtempSync(join(tmpdir(), "guardian-grant-minting-test-"));

mock.module("../util/platform.js", () => ({
  getRootDir: () => testDir,
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

import { GRANT_TTL_MS } from "../approvals/guardian-decision-primitive.js";
import type { Session } from "../daemon/session.js";
import type { TrustContext } from "../daemon/session-runtime-assembly.js";
import { getDb, initializeDb, resetDb } from "../memory/db.js";
import {
  createApprovalRequest,
  type GuardianApprovalRequest,
} from "../memory/guardian-approvals.js";
import * as approvalMessageComposer from "../runtime/approval-message-composer.js";
import * as gatewayClient from "../runtime/gateway-client.js";
import * as pendingInteractions from "../runtime/pending-interactions.js";
import { handleApprovalInterception } from "../runtime/routes/guardian-approval-interception.js";
import { computeToolApprovalDigest } from "../security/tool-approval-digest.js";

import "../memory/scoped-approval-grants.js";

initializeDb();

afterAll(() => {
  resetDb();
  try {
    rmSync(testDir, { recursive: true });
  } catch {
    /* best effort */
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ASSISTANT_ID = "self";
const GUARDIAN_USER = "guardian-user-1";
const GUARDIAN_CHAT = "guardian-chat-1";
const REQUESTER_USER = "requester-user-1";
const REQUESTER_CHAT = "requester-chat-1";
const CONVERSATION_ID = "conv-1";
const TOOL_NAME = "execute_shell";
const TOOL_INPUT = { command: "rm -rf /tmp/test" };

function resetTables(): void {
  try {
    const db = getDb();
    db.run("DELETE FROM channel_guardian_approval_requests");
    db.run("DELETE FROM scoped_approval_grants");
  } catch {
    /* tables may not exist yet */
  }
  pendingInteractions.clear();
}

function createTestGuardianApproval(
  requestId: string,
  overrides: Partial<Parameters<typeof createApprovalRequest>[0]> = {},
): GuardianApprovalRequest {
  return createApprovalRequest({
    runId: `run-${requestId}`,
    requestId,
    conversationId: CONVERSATION_ID,
    channel: "telegram",
    requesterExternalUserId: REQUESTER_USER,
    requesterChatId: REQUESTER_CHAT,
    guardianExternalUserId: GUARDIAN_USER,
    guardianChatId: GUARDIAN_CHAT,
    toolName: TOOL_NAME,
    expiresAt: Date.now() + 300_000,
    ...overrides,
  });
}

function registerPendingInteraction(
  requestId: string,
  conversationId: string,
  toolName: string,
  input: Record<string, unknown> = TOOL_INPUT,
): ReturnType<typeof mock> {
  const handleConfirmationResponse = mock(() => {});
  const mockSession = {
    handleConfirmationResponse,
  } as unknown as Session;

  pendingInteractions.register(requestId, {
    session: mockSession,
    conversationId,
    kind: "confirmation",
    confirmationDetails: {
      toolName,
      input,
      riskLevel: "high",
      allowlistOptions: [
        { label: "test", description: "test", pattern: "test" },
      ],
      scopeOptions: [{ label: "everywhere", scope: "everywhere" }],
    },
  });

  return handleConfirmationResponse;
}

function makeTrustContext(): TrustContext {
  return {
    sourceChannel: "telegram",
    trustClass: "guardian",
  };
}

function countGrants(): number {
  try {
    const db = getDb();
    const row = db.$client
      .prepare("SELECT count(*) as cnt FROM scoped_approval_grants")
      .get() as { cnt: number };
    return row.cnt;
  } catch {
    return 0;
  }
}

function getLatestGrant(): Record<string, unknown> | null {
  try {
    const db = getDb();
    const row = db.$client
      .prepare(
        "SELECT * FROM scoped_approval_grants ORDER BY created_at DESC LIMIT 1",
      )
      .get();
    return (row as Record<string, unknown>) ?? null;
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

describe("guardian grant minting on tool-approval decisions", () => {
  let deliverSpy: ReturnType<typeof spyOn>;
  let composeSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    resetTables();
    deliverSpy = spyOn(gatewayClient, "deliverChannelReply").mockResolvedValue({
      ok: true,
    });
    composeSpy = spyOn(
      approvalMessageComposer,
      "composeApprovalMessageGenerative",
    ).mockResolvedValue("test message");
  });

  // ── 1. approve_once via callback mints a grant ──

  test("approve_once via callback for tool-approval request mints a scoped grant", async () => {
    const requestId = "req-grant-cb-1";
    createTestGuardianApproval(requestId);
    registerPendingInteraction(
      requestId,
      CONVERSATION_ID,
      TOOL_NAME,
      TOOL_INPUT,
    );

    const result = await handleApprovalInterception({
      conversationId: "guardian-conv-1",
      callbackData: `apr:${requestId}:approve_once`,
      content: "",
      conversationExternalId: GUARDIAN_CHAT,
      sourceChannel: "telegram",
      actorExternalId: GUARDIAN_USER,
      replyCallbackUrl: "https://gateway.test/deliver",
      trustCtx: makeTrustContext(),
      assistantId: ASSISTANT_ID,
    });

    expect(result.handled).toBe(true);
    expect(result.type).toBe("guardian_decision_applied");

    // Verify a grant was minted
    expect(countGrants()).toBe(1);

    const grant = getLatestGrant();
    expect(grant).not.toBeNull();
    expect(grant!.scope_mode).toBe("tool_signature");
    expect(grant!.tool_name).toBe(TOOL_NAME);
    expect(grant!.status).toBe("active");
    expect(grant!.request_channel).toBe("telegram");
    expect(grant!.decision_channel).toBe("telegram");
    expect(grant!.guardian_external_user_id).toBe(GUARDIAN_USER);
    expect(grant!.requester_external_user_id).toBe(REQUESTER_USER);
    expect(grant!.conversation_id).toBe(CONVERSATION_ID);
    expect(grant!.execution_channel).toBeNull();
    expect(grant!.call_session_id).toBeNull();

    // Verify the input digest matches what computeToolApprovalDigest produces
    const expectedDigest = computeToolApprovalDigest(TOOL_NAME, TOOL_INPUT);
    expect(grant!.input_digest).toBe(expectedDigest);

    deliverSpy.mockRestore();
    composeSpy.mockRestore();
  });

  // ── 2. approve_once for non-tool-approval does NOT mint a grant ──

  test("approve_once for informational request (no toolName) does NOT mint a grant", async () => {
    const requestId = "req-no-grant-1";
    // Informational requests have no meaningful tool name — the empty string
    // signals that this is not a tool-approval request.
    createTestGuardianApproval(requestId, { toolName: "" });
    registerPendingInteraction(requestId, CONVERSATION_ID, "", {});

    const result = await handleApprovalInterception({
      conversationId: "guardian-conv-2",
      callbackData: `apr:${requestId}:approve_once`,
      content: "",
      conversationExternalId: GUARDIAN_CHAT,
      sourceChannel: "telegram",
      actorExternalId: GUARDIAN_USER,
      replyCallbackUrl: "https://gateway.test/deliver",
      trustCtx: makeTrustContext(),
      assistantId: ASSISTANT_ID,
    });

    expect(result.handled).toBe(true);
    expect(result.type).toBe("guardian_decision_applied");

    // No grant should have been minted
    expect(countGrants()).toBe(0);

    deliverSpy.mockRestore();
    composeSpy.mockRestore();
  });

  // ── 2b. approve_once for zero-argument tool call DOES mint a grant ──

  test("approve_once for zero-argument tool call mints a scoped grant", async () => {
    const requestId = "req-grant-zero-arg";
    const zeroArgTool = "get_system_status";
    createTestGuardianApproval(requestId, { toolName: zeroArgTool });
    // Register with empty input object to simulate a zero-argument tool call
    registerPendingInteraction(requestId, CONVERSATION_ID, zeroArgTool, {});

    const result = await handleApprovalInterception({
      conversationId: "guardian-conv-2b",
      callbackData: `apr:${requestId}:approve_once`,
      content: "",
      conversationExternalId: GUARDIAN_CHAT,
      sourceChannel: "telegram",
      actorExternalId: GUARDIAN_USER,
      replyCallbackUrl: "https://gateway.test/deliver",
      trustCtx: makeTrustContext(),
      assistantId: ASSISTANT_ID,
    });

    expect(result.handled).toBe(true);
    expect(result.type).toBe("guardian_decision_applied");

    // A grant MUST be minted even though input is {}
    expect(countGrants()).toBe(1);

    const grant = getLatestGrant();
    expect(grant).not.toBeNull();
    expect(grant!.scope_mode).toBe("tool_signature");
    expect(grant!.tool_name).toBe(zeroArgTool);
    expect(grant!.status).toBe("active");

    // Verify the input digest matches what computeToolApprovalDigest produces for empty input
    const expectedDigest = computeToolApprovalDigest(zeroArgTool, {});
    expect(grant!.input_digest).toBe(expectedDigest);

    deliverSpy.mockRestore();
    composeSpy.mockRestore();
  });

  // ── 3. reject does NOT mint a grant ──

  test("reject decision does NOT mint a scoped grant", async () => {
    const requestId = "req-no-grant-rej";
    createTestGuardianApproval(requestId);
    registerPendingInteraction(
      requestId,
      CONVERSATION_ID,
      TOOL_NAME,
      TOOL_INPUT,
    );

    const result = await handleApprovalInterception({
      conversationId: "guardian-conv-3",
      callbackData: `apr:${requestId}:reject`,
      content: "",
      conversationExternalId: GUARDIAN_CHAT,
      sourceChannel: "telegram",
      actorExternalId: GUARDIAN_USER,
      replyCallbackUrl: "https://gateway.test/deliver",
      trustCtx: makeTrustContext(),
      assistantId: ASSISTANT_ID,
    });

    expect(result.handled).toBe(true);
    expect(result.type).toBe("guardian_decision_applied");

    // No grant should have been minted
    expect(countGrants()).toBe(0);

    deliverSpy.mockRestore();
    composeSpy.mockRestore();
  });

  // ── 4. Identity mismatch remains fail-closed (no grant minted) ──

  test("identity mismatch does NOT mint a grant and fails closed", async () => {
    const requestId = "req-mismatch-1";
    createTestGuardianApproval(requestId);
    registerPendingInteraction(
      requestId,
      CONVERSATION_ID,
      TOOL_NAME,
      TOOL_INPUT,
    );

    const result = await handleApprovalInterception({
      conversationId: "guardian-conv-4",
      callbackData: `apr:${requestId}:approve_once`,
      content: "",
      conversationExternalId: GUARDIAN_CHAT,
      sourceChannel: "telegram",
      actorExternalId: "wrong-guardian-user",
      replyCallbackUrl: "https://gateway.test/deliver",
      trustCtx: makeTrustContext(),
      assistantId: ASSISTANT_ID,
    });

    expect(result.handled).toBe(true);
    // Identity mismatch results in guardian_decision_applied (fail-closed, no actual decision applied)
    expect(result.type).toBe("guardian_decision_applied");

    // No grant should have been minted
    expect(countGrants()).toBe(0);

    deliverSpy.mockRestore();
    composeSpy.mockRestore();
  });

  // ── 5. Stale/already-resolved request does NOT mint a grant ──

  test("stale request (already resolved) does NOT mint a grant", async () => {
    const requestId = "req-stale-1";
    // Create guardian approval but do NOT register a pending interaction
    // This simulates the pending interaction being already resolved
    createTestGuardianApproval(requestId);

    const result = await handleApprovalInterception({
      conversationId: "guardian-conv-5",
      callbackData: `apr:${requestId}:approve_once`,
      content: "",
      conversationExternalId: GUARDIAN_CHAT,
      sourceChannel: "telegram",
      actorExternalId: GUARDIAN_USER,
      replyCallbackUrl: "https://gateway.test/deliver",
      trustCtx: makeTrustContext(),
      assistantId: ASSISTANT_ID,
    });

    expect(result.handled).toBe(true);
    expect(result.type).toBe("stale_ignored");

    // No grant should have been minted
    expect(countGrants()).toBe(0);

    deliverSpy.mockRestore();
    composeSpy.mockRestore();
  });

  // ── 6. approve_once via conversation engine mints a grant ──

  test("approve_once via conversation engine mints a scoped grant", async () => {
    const requestId = "req-grant-eng-1";
    createTestGuardianApproval(requestId);
    registerPendingInteraction(
      requestId,
      CONVERSATION_ID,
      TOOL_NAME,
      TOOL_INPUT,
    );

    const mockGenerator = async () => ({
      disposition: "approve_once" as const,
      replyText: "Approved!",
      targetRequestId: requestId,
    });

    const result = await handleApprovalInterception({
      conversationId: "guardian-conv-6",
      content: "yes, approve it",
      conversationExternalId: GUARDIAN_CHAT,
      sourceChannel: "telegram",
      actorExternalId: GUARDIAN_USER,
      replyCallbackUrl: "https://gateway.test/deliver",
      trustCtx: makeTrustContext(),
      assistantId: ASSISTANT_ID,
      approvalConversationGenerator: mockGenerator,
    });

    expect(result.handled).toBe(true);
    expect(result.type).toBe("guardian_decision_applied");

    // Verify a grant was minted
    expect(countGrants()).toBe(1);

    const grant = getLatestGrant();
    expect(grant).not.toBeNull();
    expect(grant!.scope_mode).toBe("tool_signature");
    expect(grant!.tool_name).toBe(TOOL_NAME);
    expect(grant!.status).toBe("active");

    deliverSpy.mockRestore();
    composeSpy.mockRestore();
  });

  // ── 7. reject via conversation engine does NOT mint a grant ──

  test("reject via conversation engine does NOT mint a grant", async () => {
    const requestId = "req-no-grant-eng-rej";
    createTestGuardianApproval(requestId);
    registerPendingInteraction(
      requestId,
      CONVERSATION_ID,
      TOOL_NAME,
      TOOL_INPUT,
    );

    const mockGenerator = async () => ({
      disposition: "reject" as const,
      replyText: "Denied.",
      targetRequestId: requestId,
    });

    const result = await handleApprovalInterception({
      conversationId: "guardian-conv-7",
      content: "no, deny it",
      conversationExternalId: GUARDIAN_CHAT,
      sourceChannel: "telegram",
      actorExternalId: GUARDIAN_USER,
      replyCallbackUrl: "https://gateway.test/deliver",
      trustCtx: makeTrustContext(),
      assistantId: ASSISTANT_ID,
      approvalConversationGenerator: mockGenerator,
    });

    expect(result.handled).toBe(true);
    expect(result.type).toBe("guardian_decision_applied");

    // No grant should have been minted
    expect(countGrants()).toBe(0);

    deliverSpy.mockRestore();
    composeSpy.mockRestore();
  });

  // ── 8. Grant TTL is approximately 5 minutes ──

  test("minted grant has approximately 5-minute TTL", async () => {
    const requestId = "req-grant-ttl-1";
    createTestGuardianApproval(requestId);
    registerPendingInteraction(
      requestId,
      CONVERSATION_ID,
      TOOL_NAME,
      TOOL_INPUT,
    );

    const beforeTime = Date.now();

    const result = await handleApprovalInterception({
      conversationId: "guardian-conv-9",
      callbackData: `apr:${requestId}:approve_once`,
      content: "",
      conversationExternalId: GUARDIAN_CHAT,
      sourceChannel: "telegram",
      actorExternalId: GUARDIAN_USER,
      replyCallbackUrl: "https://gateway.test/deliver",
      trustCtx: makeTrustContext(),
      assistantId: ASSISTANT_ID,
    });

    expect(result.type).toBe("guardian_decision_applied");

    const grant = getLatestGrant();
    expect(grant).not.toBeNull();

    const expiresAt = new Date(grant!.expires_at as string).getTime();
    const expectedMin = beforeTime + GRANT_TTL_MS - 1000; // 1s tolerance
    const expectedMax = beforeTime + GRANT_TTL_MS + 5000; // 5s tolerance
    expect(expiresAt).toBeGreaterThanOrEqual(expectedMin);
    expect(expiresAt).toBeLessThanOrEqual(expectedMax);

    deliverSpy.mockRestore();
    composeSpy.mockRestore();
  });
});

describe("approval interception trust-class regression coverage", () => {
  let deliverSpy: ReturnType<typeof spyOn>;
  let composeSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    resetTables();
    deliverSpy = spyOn(gatewayClient, "deliverChannelReply").mockResolvedValue({
      ok: true,
    });
    composeSpy = spyOn(
      approvalMessageComposer,
      "composeApprovalMessageGenerative",
    ).mockResolvedValue("test message");
  });

  test("identity-known unknown sender does not auto-deny pending approval", async () => {
    const requestId = "req-unknown-no-auto-deny-1";
    const sessionMock = registerPendingInteraction(
      requestId,
      CONVERSATION_ID,
      TOOL_NAME,
      TOOL_INPUT,
    );
    createTestGuardianApproval(requestId);

    const result = await handleApprovalInterception({
      conversationId: CONVERSATION_ID,
      content: "approve",
      conversationExternalId: REQUESTER_CHAT,
      sourceChannel: "telegram",
      actorExternalId: "intruder-user-1",
      replyCallbackUrl: "https://gateway.test/deliver",
      trustCtx: {
        sourceChannel: "telegram",
        trustClass: "unknown",
        requesterExternalUserId: "intruder-user-1",
        guardianExternalUserId: "guardian-1",
      },
      assistantId: ASSISTANT_ID,
    });

    expect(result.handled).toBe(true);
    expect(result.type).toBe("assistant_turn");
    expect(sessionMock).not.toHaveBeenCalled();

    deliverSpy.mockRestore();
    composeSpy.mockRestore();
  });

  test("legacy unverified sender still auto-denies pending approval", async () => {
    const requestId = "req-unknown-auto-deny-1";
    const sessionMock = registerPendingInteraction(
      requestId,
      CONVERSATION_ID,
      TOOL_NAME,
      TOOL_INPUT,
    );
    createTestGuardianApproval(requestId);

    const result = await handleApprovalInterception({
      conversationId: CONVERSATION_ID,
      content: "approve",
      conversationExternalId: REQUESTER_CHAT,
      sourceChannel: "telegram",
      actorExternalId: undefined,
      replyCallbackUrl: "https://gateway.test/deliver",
      trustCtx: {
        sourceChannel: "telegram",
        trustClass: "unknown",
      },
      assistantId: ASSISTANT_ID,
    });

    expect(result.handled).toBe(true);
    expect(result.type).toBe("decision_applied");
    expect(sessionMock).toHaveBeenCalled();
    expect(sessionMock.mock.calls[0]?.[0]).toBe(requestId);
    expect(sessionMock.mock.calls[0]?.[1]).toBe("deny");

    deliverSpy.mockRestore();
    composeSpy.mockRestore();
  });
});
