import { describe, expect, test } from "bun:test";

import { runApprovalConversationTurn } from "../runtime/approval-conversation-turn.js";
import type {
  ApprovalConversationContext,
  ApprovalConversationGenerator,
  ApprovalConversationResult,
} from "../runtime/http-types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContext(
  overrides: Partial<ApprovalConversationContext> = {},
): ApprovalConversationContext {
  return {
    toolName: "execute_shell",
    allowedActions: ["approve_once", "reject"],
    role: "guardian",
    pendingApprovals: [{ requestId: "run-1", toolName: "execute_shell" }],
    userMessage: "yes, go ahead",
    ...overrides,
  };
}

function makeGenerator(
  result: ApprovalConversationResult,
): ApprovalConversationGenerator {
  return async () => result;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runApprovalConversationTurn", () => {
  test("successful keep_pending response (non-decision message)", async () => {
    const result = await runApprovalConversationTurn(
      makeContext({ userMessage: "what does this tool do?" }),
      makeGenerator({
        disposition: "keep_pending",
        replyText:
          "This tool runs shell commands. Would you like to approve it?",
      }),
    );
    expect(result.disposition).toBe("keep_pending");
    expect(result.replyText).toBe(
      "This tool runs shell commands. Would you like to approve it?",
    );
    expect(result.targetRequestId).toBeUndefined();
  });

  test("successful approve_once response", async () => {
    const result = await runApprovalConversationTurn(
      makeContext(),
      makeGenerator({
        disposition: "approve_once",
        replyText: "Approved! Running the command now.",
        targetRequestId: "run-1",
      }),
    );
    expect(result.disposition).toBe("approve_once");
    expect(result.replyText).toBe("Approved! Running the command now.");
    expect(result.targetRequestId).toBe("run-1");
  });

  test("successful reject response", async () => {
    const result = await runApprovalConversationTurn(
      makeContext(),
      makeGenerator({
        disposition: "reject",
        replyText: "Request denied.",
        targetRequestId: "run-1",
      }),
    );
    expect(result.disposition).toBe("reject");
    expect(result.replyText).toBe("Request denied.");
  });

  test("fail-closed on generator throwing an error", async () => {
    const throwingGenerator: ApprovalConversationGenerator = async () => {
      throw new Error("provider timeout");
    };
    const result = await runApprovalConversationTurn(
      makeContext(),
      throwingGenerator,
    );
    expect(result.disposition).toBe("keep_pending");
    expect(result.replyText).toContain("couldn't process");
  });

  test("fail-closed on generator returning malformed output", async () => {
    const malformedGenerator: ApprovalConversationGenerator = async () => {
      // Return an object missing the required replyText
      return {
        disposition: "approve_once",
        replyText: "",
      } as ApprovalConversationResult;
    };
    const result = await runApprovalConversationTurn(
      makeContext(),
      malformedGenerator,
    );
    expect(result.disposition).toBe("keep_pending");
    expect(result.replyText).toContain("couldn't process");
  });

  test("fail-closed on invalid disposition", async () => {
    const badDisposition: ApprovalConversationGenerator = async () => {
      return { disposition: "yolo" as "approve_once", replyText: "Sure!" };
    };
    const result = await runApprovalConversationTurn(
      makeContext(),
      badDisposition,
    );
    expect(result.disposition).toBe("keep_pending");
    expect(result.replyText).toContain("couldn't process");
  });

  test("fail-closed when disposition is not in allowedActions", async () => {
    const result = await runApprovalConversationTurn(
      makeContext(),
      makeGenerator({
        disposition: "unknown_action" as "approve_once",
        replyText: "Approved permanently!",
        targetRequestId: "run-1",
      }),
    );
    expect(result.disposition).toBe("keep_pending");
    expect(result.replyText).toContain("couldn't process");
  });

  test("keep_pending is always allowed regardless of allowedActions", async () => {
    const restrictedContext = makeContext({
      allowedActions: ["approve_once", "reject"],
    });

    const result = await runApprovalConversationTurn(
      restrictedContext,
      makeGenerator({
        disposition: "keep_pending",
        replyText: "Can you tell me more about this request?",
      }),
    );
    expect(result.disposition).toBe("keep_pending");
    expect(result.replyText).toBe("Can you tell me more about this request?");
  });

  test("fail-closed when single pending approval and hallucinated targetRequestId", async () => {
    // Only one pending approval, but model returns a non-matching targetRequestId
    const result = await runApprovalConversationTurn(
      makeContext({
        pendingApprovals: [{ requestId: "run-1", toolName: "execute_shell" }],
      }),
      makeGenerator({
        disposition: "approve_once",
        replyText: "Approved!",
        targetRequestId: "run-nonexistent",
      }),
    );
    expect(result.disposition).toBe("keep_pending");
    expect(result.replyText).toContain("couldn't process");
  });

  test("fail-closed when targetRequestId does not match any pending approval", async () => {
    const contextWithMultiple = makeContext({
      pendingApprovals: [
        { requestId: "run-1", toolName: "execute_shell" },
        { requestId: "run-2", toolName: "file_write" },
      ],
    });

    // Hallucinated run ID that doesn't match any pending approval
    const result = await runApprovalConversationTurn(
      contextWithMultiple,
      makeGenerator({
        disposition: "approve_once",
        replyText: "Approved!",
        targetRequestId: "run-nonexistent",
      }),
    );
    expect(result.disposition).toBe("keep_pending");
    expect(result.replyText).toContain("couldn't process");
  });

  test("targetRequestId validation when multiple pending approvals", async () => {
    const contextWithMultiple = makeContext({
      pendingApprovals: [
        { requestId: "run-1", toolName: "execute_shell" },
        { requestId: "run-2", toolName: "file_write" },
      ],
    });

    // Decision-bearing disposition without targetRequestId should fail-close
    const resultWithoutTarget = await runApprovalConversationTurn(
      contextWithMultiple,
      makeGenerator({
        disposition: "approve_once",
        replyText: "Approved!",
        // no targetRequestId
      }),
    );
    expect(resultWithoutTarget.disposition).toBe("keep_pending");
    expect(resultWithoutTarget.replyText).toContain("couldn't process");

    // Decision-bearing disposition with targetRequestId should succeed
    const resultWithTarget = await runApprovalConversationTurn(
      contextWithMultiple,
      makeGenerator({
        disposition: "approve_once",
        replyText: "Approved!",
        targetRequestId: "run-1",
      }),
    );
    expect(resultWithTarget.disposition).toBe("approve_once");
    expect(resultWithTarget.targetRequestId).toBe("run-1");

    // Non-decision disposition without targetRequestId should pass through fine
    const resultKeepPending = await runApprovalConversationTurn(
      contextWithMultiple,
      makeGenerator({
        disposition: "keep_pending",
        replyText: "Which request would you like to approve?",
      }),
    );
    expect(resultKeepPending.disposition).toBe("keep_pending");
  });
});
