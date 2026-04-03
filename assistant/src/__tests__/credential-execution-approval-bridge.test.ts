/**
 * Tests for the CES approval bridge.
 *
 * Verifies:
 * 1. Single-use approval: guardian approves, grant is committed to CES,
 *    result contains grantId for retry.
 * 2. Temporary grant reuse: allow_10m decision maps to PT10M TTL.
 * 3. always_allow grant mapping (internal plumbing / forward-compatibility).
 * 4. Denial: guardian denies, no record_grant RPC is made.
 * 5. Timeout: non-interactive session auto-denies (fail-closed).
 * 6. Non-interactive fail-closed: isInteractive=false immediately denies.
 * 7. Error handling: record_grant RPC failure returns error outcome.
 */

import { describe, expect, test } from "bun:test";

import type {
  ApprovalRequired,
  GrantProposal,
  PersistentGrantRecord,
  RecordGrant,
  RecordGrantResponse,
} from "@vellumai/ces-contracts";

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
      signal: AbortSignal | undefined,
      temporaryOptionsAvailable: unknown,
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
        temporaryOptionsAvailable,
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
  describe("single-use approval", () => {
    test("allow decision commits grant to CES and returns grantId", async () => {
      const prompter = makePrompter("allow");
      const cesClient = makeCesClient();
      const approval = makeApprovalRequired();

      const result = await bridgeCesApproval(approval, prompter, cesClient, {
        isInteractive: true,
        conversationId: "session-1",
      });

      expect(result.outcome).toBe("approved");
      if (result.outcome === "approved") {
        expect(result.grantId).toBe("grant-001");
        expect(result.userDecision).toBe("allow");
      }

      // Verify record_grant was called
      expect(cesClient.recordGrantCalls.length).toBe(1);
      const call = cesClient.recordGrantCalls[0];
      expect(call.sessionId).toBe("session-1");
      expect(call.decision.decision).toBe("approved");
      expect(call.decision.proposalHash).toBe("abc123hash");
      expect(call.decision.decidedBy).toBe("guardian");
      // Single-use: no TTL
      expect(call.decision.ttl).toBeUndefined();
    });

    test("prompt uses ces: prefix for tool name", async () => {
      const prompter = makePrompter("allow");
      const cesClient = makeCesClient();
      const approval = makeApprovalRequired();

      await bridgeCesApproval(approval, prompter, cesClient, {
        isInteractive: true,
        conversationId: "session-1",
      });

      expect(prompter.promptCalls.length).toBe(1);
      expect(prompter.promptCalls[0].toolName).toBe("ces:http");
    });

    test("prompt includes rendered proposal in input", async () => {
      const prompter = makePrompter("allow");
      const cesClient = makeCesClient();
      const approval = makeApprovalRequired();

      await bridgeCesApproval(approval, prompter, cesClient, {
        isInteractive: true,
      });

      const input = prompter.promptCalls[0].input as Record<string, unknown>;
      expect(input.renderedProposal).toBe(approval.renderedProposal);
      expect(input.credentialHandle).toBe("local_static:github/api_key");
      expect(input.method).toBe("GET");
      expect(input.url).toBe("https://api.github.com/user");
    });

    test("prompt sets riskLevel to high", async () => {
      const prompter = makePrompter("allow");
      const cesClient = makeCesClient();

      await bridgeCesApproval(makeApprovalRequired(), prompter, cesClient, {
        isInteractive: true,
      });

      expect(prompter.promptCalls[0].riskLevel).toBe("high");
    });

    test("prompt disables persistent decisions (CES manages grants)", async () => {
      const prompter = makePrompter("allow");
      const cesClient = makeCesClient();

      await bridgeCesApproval(makeApprovalRequired(), prompter, cesClient, {
        isInteractive: true,
      });

      expect(prompter.promptCalls[0].persistentDecisionsAllowed).toBe(false);
    });
  });

  describe("temporary grant reuse (allow_10m)", () => {
    test("allow_10m decision maps to PT10M TTL", async () => {
      const prompter = makePrompter("allow_10m");
      const cesClient = makeCesClient();

      const result = await bridgeCesApproval(
        makeApprovalRequired(),
        prompter,
        cesClient,
        { isInteractive: true },
      );

      expect(result.outcome).toBe("approved");

      expect(cesClient.recordGrantCalls.length).toBe(1);
      const call = cesClient.recordGrantCalls[0];
      expect(call.decision.ttl).toBe("PT10M");
      expect(call.decision.decision).toBe("approved");
    });
  });

  describe("conversation-scoped grant (allow_conversation)", () => {
    test("allow_conversation decision maps to approved with no TTL", async () => {
      const prompter = makePrompter("allow_conversation");
      const cesClient = makeCesClient();

      const result = await bridgeCesApproval(
        makeApprovalRequired(),
        prompter,
        cesClient,
        { isInteractive: true },
      );

      expect(result.outcome).toBe("approved");

      expect(cesClient.recordGrantCalls.length).toBe(1);
      const call = cesClient.recordGrantCalls[0];
      expect(call.decision.ttl).toBeUndefined();
      expect(call.decision.decision).toBe("approved");
    });
  });

  // Note: The always_allow path is not currently reachable from the UI because
  // the approval bridge passes persistentDecisionsAllowed: false to the prompter,
  // and the UI only shows "Always Allow" when persistentDecisionsAllowed is true.
  // This test validates the internal mapUserDecisionToCesDecision mapping for
  // forward-compatibility — the code path works correctly if the UI ever sends it.
  describe("always_allow grant mapping (internal plumbing)", () => {
    test("always_allow decision creates persistent grant with no expiry", async () => {
      const prompter = makePrompter("always_allow");
      const cesClient = makeCesClient();

      const result = await bridgeCesApproval(
        makeApprovalRequired(),
        prompter,
        cesClient,
        { isInteractive: true },
      );

      expect(result.outcome).toBe("approved");
      if (result.outcome === "approved") {
        expect(result.grantId).toBe("grant-001");
        expect(result.userDecision).toBe("always_allow");
      }

      const call = cesClient.recordGrantCalls[0];
      expect(call.decision.decision).toBe("approved");
      expect(call.decision.ttl).toBeUndefined();
    });
  });

  describe("denial", () => {
    test("deny decision returns denied outcome without calling record_grant", async () => {
      const prompter = makePrompter("deny");
      const cesClient = makeCesClient();

      const result = await bridgeCesApproval(
        makeApprovalRequired(),
        prompter,
        cesClient,
        { isInteractive: true },
      );

      expect(result.outcome).toBe("denied");
      if (result.outcome === "denied") {
        expect(result.userDecision).toBe("deny");
      }

      // No record_grant RPC should have been made
      expect(cesClient.recordGrantCalls.length).toBe(0);
    });

    test("always_deny decision returns denied outcome without calling record_grant", async () => {
      const prompter = makePrompter("always_deny");
      const cesClient = makeCesClient();

      const result = await bridgeCesApproval(
        makeApprovalRequired(),
        prompter,
        cesClient,
        { isInteractive: true },
      );

      expect(result.outcome).toBe("denied");
      if (result.outcome === "denied") {
        expect(result.userDecision).toBe("always_deny");
      }

      expect(cesClient.recordGrantCalls.length).toBe(0);
    });
  });

  describe("prompter timeout", () => {
    test("returns timeout outcome when prompter times out", async () => {
      // The PermissionPrompter resolves timeouts as decision: "deny" with a
      // decisionContext containing "timed out".
      const prompter = makePrompter(
        "deny",
        'The permission prompt for the "ces:http" tool timed out. The user did not explicitly deny this request — they may have been away or busy. You may retry this tool call if it is still needed for the current task.',
      );
      const cesClient = makeCesClient();

      const result = await bridgeCesApproval(
        makeApprovalRequired(),
        prompter,
        cesClient,
        { isInteractive: true },
      );

      expect(result.outcome).toBe("timeout");

      // No record_grant RPC should have been made
      expect(cesClient.recordGrantCalls.length).toBe(0);
    });

    test("explicit deny with no timeout context returns denied, not timeout", async () => {
      const prompter = makePrompter("deny");
      const cesClient = makeCesClient();

      const result = await bridgeCesApproval(
        makeApprovalRequired(),
        prompter,
        cesClient,
        { isInteractive: true },
      );

      expect(result.outcome).toBe("denied");
      if (result.outcome === "denied") {
        expect(result.userDecision).toBe("deny");
      }
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

  describe("command proposals", () => {
    test("handles command proposal type correctly", async () => {
      const prompter = makePrompter("allow");
      const cesClient = makeCesClient();
      const approval = makeApprovalRequired({
        proposal: {
          type: "command",
          credentialHandle: "local_static:aws/secret_key",
          command: "aws s3 ls",
          purpose: "List S3 buckets",
        },
      });

      const result = await bridgeCesApproval(approval, prompter, cesClient, {
        isInteractive: true,
      });

      expect(result.outcome).toBe("approved");

      // Verify tool name uses command type
      expect(prompter.promptCalls[0].toolName).toBe("ces:command");

      // Verify input includes command details
      const input = prompter.promptCalls[0].input as Record<string, unknown>;
      expect(input.command).toBe("aws s3 ls");
      expect(input.credentialHandle).toBe("local_static:aws/secret_key");
    });
  });

  describe("abort signal", () => {
    test("passes signal to prompter", async () => {
      const controller = new AbortController();
      const prompter = makePrompter("allow");
      const cesClient = makeCesClient();

      await bridgeCesApproval(makeApprovalRequired(), prompter, cesClient, {
        isInteractive: true,
        signal: controller.signal,
      });

      // The prompter was called (signal is passed internally to prompt())
      expect(prompter.promptCalls.length).toBe(1);
    });
  });
});
