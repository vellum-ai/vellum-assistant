/**
 * `createCanonicalRequestForConfirmation` must pin an `inputDigest` on the
 * canonical tool_approval request — `mintCanonicalRequestGrant` no-ops without
 * one, so the channel tool approval would mint no scoped grant.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, { get: () => () => {} }),
  truncateForLog: (value: string) => value,
}));

// A channel confirmation with a bound guardian principal — the store refuses to
// create a decisionable tool_approval request without a guardianPrincipalId.
mock.module("../daemon/conversation-registry.js", () => ({
  findConversation: () => ({
    assistantId: "self",
    trustContext: {
      sourceChannel: "slack",
      guardianPrincipalId: "principal-1",
      guardianExternalUserId: "guardian-1",
      requesterExternalUserId: "requester-1",
      requesterChatId: "chat-1",
    },
  }),
}));

// Stub the guardian bridge so creating the request doesn't pull in the
// notification pipeline — this test only asserts the persisted request's digest.
mock.module("../runtime/confirmation-request-guardian-bridge.js", () => ({
  bridgeConfirmationRequestToGuardian: () => {},
}));

import { getCanonicalGuardianRequest } from "../memory/canonical-guardian-store.js";
import { getDb } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import { broadcastMessage } from "../runtime/assistant-event-hub.js";
import { computeToolApprovalDigest } from "../security/tool-approval-digest.js";

initializeDb();

function resetTables(): void {
  const db = getDb();
  db.run("DELETE FROM canonical_guardian_deliveries");
  db.run("DELETE FROM canonical_guardian_requests");
}

/** Poll for the fire-and-forget canonical request the producer creates. */
async function waitForCanonicalRequest(requestId: string) {
  for (let i = 0; i < 50; i++) {
    const req = getCanonicalGuardianRequest(requestId);
    if (req) return req;
    await new Promise((r) => setTimeout(r, 5));
  }
  return getCanonicalGuardianRequest(requestId);
}

function emitConfirmation(
  requestId: string,
  toolName: string,
  input: Record<string, unknown>,
  conversationId = "conv-digest-1",
): void {
  broadcastMessage(
    {
      type: "confirmation_request",
      requestId,
      toolName,
      input,
      riskLevel: "high",
      executionTarget: "host",
      allowlistOptions: [],
      scopeOptions: [],
      conversationId,
      persistentDecisionsAllowed: false,
    } as Parameters<typeof broadcastMessage>[0],
    conversationId,
  );
}

describe("canonical tool-approval request inputDigest (LUM-2496)", () => {
  beforeEach(() => resetTables());

  test("createCanonicalRequestForConfirmation pins the tool-input digest", async () => {
    const requestId = "req-digest-1";
    const toolName = "execute_shell";
    const input = { command: "rm -rf /tmp/build-cache" };

    emitConfirmation(requestId, toolName, input);
    const req = await waitForCanonicalRequest(requestId);

    expect(req).not.toBeNull();
    expect(req!.kind).toBe("tool_approval");
    // Digest is set and equals what the tool-approval handler computes for this
    // (unredacted) input.
    expect(req!.inputDigest).toBe(computeToolApprovalDigest(toolName, input));
    expect(req!.inputDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  test("a different tool input yields a different digest", async () => {
    const toolName = "execute_shell";

    emitConfirmation("req-digest-a", toolName, { command: "ls" });
    emitConfirmation("req-digest-b", toolName, { command: "whoami" });
    const a = await waitForCanonicalRequest("req-digest-a");
    const b = await waitForCanonicalRequest("req-digest-b");

    expect(a!.inputDigest).toBeTruthy();
    expect(b!.inputDigest).toBeTruthy();
    expect(a!.inputDigest).not.toBe(b!.inputDigest);
  });
});
