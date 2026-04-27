/**
 * Tests for the CES approval bridge.
 *
 * Verifies:
 * 1. Auto-approval: interactive sessions auto-approve without prompting.
 * 2. Non-interactive fail-closed: isInteractive=false immediately denies.
 * 3. Error handling: record_grant RPC failure returns error outcome.
 */

import { describe, expect, test } from "bun:test";

import type {
  ApprovalRequired,
  GrantProposal,
  PersistentGrantRecord,
  RecordGrant,
  RecordGrantResponse,
} from "@vellumai/service-contracts/credential-rpc";

import { bridgeCesApproval } from "../credential-execution/approval-bridge.js";
import type { CesClient } from "../credential-execution/client.js";
import type { PermissionPrompter } from "../permissions/prompter.js";
import type { UserDecision } from "../permissions/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProposal(
  overrides?: Partial<GrantProposal & { type: "http" }>,
): GrantProposal {
  return {
    type: "http",
    credentialHandle: "local_static:github/api_key",
    method: "GET",
    url: "https://api.github.com/user",
    purpose: "Fetch user profile",
    ...overrides,
  };
}

function makeApprovalRequired(
  overrides?: Partial<ApprovalRequired>,
): ApprovalRequired {
  return {
    proposal: makeProposal(),
    proposalHash: "abc123hash",
    renderedProposal:
      "Authenticated HTTP Request\n  Method: GET\n  URL: https://api.github.com/user\n  Credential: local_static:github/api_key\n  Purpose: Fetch user profile",
    sessionId: "session-1",
    ...overrides,
  };
}

function makeGrantRecord(
  overrides?: Partial<PersistentGrantRecord>,
): PersistentGrantRecord {
  return {
    grantId: "grant-001",
    sessionId: "session-1",
    credentialHandle: "local_static:github/api_key",
    proposalType: "http",
    proposalHash: "abc123hash",
    allowedPurposes: ["https://api.github.com/**"],
    status: "active",
    grantedBy: "guardian",
    createdAt: new Date().toISOString(),
    expiresAt: null,
    consumedAt: null,
    revokedAt: null,
    ...overrides,
  };
}

/**
 * Create a mock PermissionPrompter that resolves with the given decision.
 */
function makePrompter(
  decision: UserDecision,
  decisionContext?: string,
): PermissionPrompter & { promptCalls: Array<Record<string, unknown>> } {
  const promptCalls: Array<Record<string, unknown>> = [];

  return {
    promptCalls,
    prompt: async (
      toolName: string,
      input: Record<string, unknown>,
      riskLevel: string,
      allowlistOptions: unknown[],
      scopeOptions: unknown[],
      diff: unknown,
      sessionId: string | undefined,
      executionTarget: unknown,
      persistentDecisionsAllowed: unknown,
      _signal: AbortSignal | undefined,
    ) => {
      promptCalls.push({
        toolName,
        input,
        riskLevel,
        allowlistOptions,
        scopeOptions,
        diff,
        sessionId,
        executionTarget,
        persistentDecisionsAllowed,
      });
      return { decision, decisionContext };
    },
    resolveConfirmation: () => {},
    updateSender: () => {},
    dispose: () => {},
    hasPending: false,
    hasPendingRequest: () => false,
    getPendingRequestIds: () => [],
    getToolUseId: () => undefined,
    denyAllPending: () => {},
    setOnStateChanged: () => {},
  } as unknown as PermissionPrompter & {
    promptCalls: Array<Record<string, unknown>>;
  };
}

/**
 * Create a mock CesClient that captures record_grant calls.
 */
function makeCesClient(
  grantResponse?: RecordGrantResponse,
  callError?: Error,
): CesClient & {
  recordGrantCalls: RecordGrant[];
} {
  const recordGrantCalls: RecordGrant[] = [];

  return {
    recordGrantCalls,
    handshake: async () => ({ accepted: true }),
    isReady: () => true,
    close: () => {},
    call: async (method: string, request: unknown) => {
      if (method === "record_grant") {
        recordGrantCalls.push(request as RecordGrant);
        if (callError) throw callError;
        return (
          grantResponse ?? {
            success: true,
            grant: makeGrantRecord(),
          }
        );
      }
      throw new Error(`Unexpected RPC method: ${method}`);
    },
  } as unknown as CesClient & { recordGrantCalls: RecordGrant[] };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CES approval bridge", () => {
  describe("guardian prompt (interactive sessions)", () => {
    test("prompts guardian and commits approved grant to CES", async () => {
      const prompter = makePrompter("allow");
      const cesClient = makeCesClient();

      const result = await bridgeCesApproval(
        makeApprovalRequired(),
        prompter,
        cesClient,
        { isInteractive: true, conversationId: "session-1" },
      );

      expect(result.outcome).toBe("approved");
      if (result.outcome === "approved") {
        expect(result.userDecision).toBe("allow");
        expect(result.grantId).toBe("grant-001");
      }
      // Prompter should have been called for guardian approval
      expect(prompter.promptCalls).toHaveLength(1);
      // record_grant RPC should have been called
      expect(cesClient.recordGrantCalls).toHaveLength(1);
      const call = cesClient.recordGrantCalls[0];
      expect(call.sessionId).toBe("session-1");
      expect(call.decision.decision).toBe("approved");
      expect(call.decision.proposalHash).toBe("abc123hash");
      expect(call.decision.decidedBy).toBe("guardian");
      expect(call.decision.grantType).toBe("allow_once");
      // Single-use: no TTL
      expect(call.decision.ttl).toBeUndefined();
    });

    test("prompts guardian and commits denied grant to CES", async () => {
      const prompter = makePrompter("deny");
      const cesClient = makeCesClient();

      const result = await bridgeCesApproval(
        makeApprovalRequired(),
        prompter,
        cesClient,
        { isInteractive: true, conversationId: "session-1" },
      );

      expect(result.outcome).toBe("denied");
      if (result.outcome === "denied") {
        expect(result.userDecision).toBe("deny");
      }
      expect(prompter.promptCalls).toHaveLength(1);
    });
  });

  describe("non-interactive fail-closed", () => {
    test("auto-denies when isInteractive is false", async () => {
      const prompter = makePrompter("allow");
      const cesClient = makeCesClient();

      const result = await bridgeCesApproval(
        makeApprovalRequired(),
        prompter,
        cesClient,
        { isInteractive: false },
      );

      expect(result.outcome).toBe("denied");
      if (result.outcome === "denied") {
        expect(result.userDecision).toBe("deny");
      }

      // Prompter should NOT have been called
      expect(prompter.promptCalls.length).toBe(0);
      // No record_grant RPC should have been made
      expect(cesClient.recordGrantCalls.length).toBe(0);
    });
  });

  describe("error handling", () => {
    test("returns error outcome when record_grant RPC fails", async () => {
      const prompter = makePrompter("allow");
      const cesClient = makeCesClient(undefined, new Error("RPC timeout"));

      const result = await bridgeCesApproval(
        makeApprovalRequired(),
        prompter,
        cesClient,
        { isInteractive: true },
      );

      expect(result.outcome).toBe("error");
      if (result.outcome === "error") {
        expect(result.message).toContain("RPC timeout");
      }
    });

    test("returns error outcome when record_grant returns success=false", async () => {
      const prompter = makePrompter("allow");
      const cesClient = makeCesClient({
        success: false,
        error: {
          code: "INVALID_PROPOSAL",
          message: "Proposal hash mismatch",
        },
      });

      const result = await bridgeCesApproval(
        makeApprovalRequired(),
        prompter,
        cesClient,
        { isInteractive: true },
      );

      expect(result.outcome).toBe("error");
      if (result.outcome === "error") {
        expect(result.message).toContain("Proposal hash mismatch");
      }
    });

    test("returns error outcome when record_grant returns no grantId", async () => {
      const prompter = makePrompter("allow");
      const cesClient = makeCesClient({
        success: true,
        // No grant field
      });

      const result = await bridgeCesApproval(
        makeApprovalRequired(),
        prompter,
        cesClient,
        { isInteractive: true },
      );

      expect(result.outcome).toBe("error");
      if (result.outcome === "error") {
        expect(result.message).toContain("no grantId");
      }
    });
  });
});
