import { beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

mock.module("../config/env.js", () => ({ isHttpAuthDisabled: () => true }));

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import type { Conversation } from "../daemon/conversation.js";
import * as trustStore from "../permissions/trust-store.js";
import type {
  ApprovalDecisionResult,
  ChannelApprovalPrompt,
} from "../runtime/channel-approval-types.js";
import type { PendingApprovalInfo } from "../runtime/channel-approvals.js";
import {
  buildApprovalUIMetadata,
  buildGuardianApprovalPrompt,
  channelSupportsRichApprovalUI,
  getChannelApprovalPrompt,
  handleChannelDecision,
} from "../runtime/channel-approvals.js";
import * as pendingInteractions from "../runtime/pending-interactions.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function registerPendingConfirmation(
  requestId: string,
  conversationId: string,
  toolName: string,
  opts?: {
    input?: Record<string, unknown>;
    riskLevel?: string;
    persistentDecisionsAllowed?: boolean;
    allowlistOptions?: Array<{
      label: string;
      description: string;
      pattern: string;
    }>;
    scopeOptions?: Array<{ label: string; scope: string }>;
    executionTarget?: "sandbox" | "host";
  },
): void {
  const mockSession = {
    handleConfirmationResponse: mock(() => {}),
    ensureActorScopedHistory: async () => {},
  } as unknown as Conversation;

  pendingInteractions.register(requestId, {
    conversation: mockSession,
    conversationId,
    kind: "confirmation",
    confirmationDetails: {
      toolName,
      input: opts?.input ?? { command: "rm -rf /tmp/test" },
      riskLevel: opts?.riskLevel ?? "high",
      allowlistOptions: opts?.allowlistOptions ?? [
        {
          label: "rm -rf /tmp/test",
          description: "rm -rf /tmp/test",
          pattern: "rm -rf /tmp/test",
        },
      ],
      scopeOptions: opts?.scopeOptions ?? [
        { label: "everywhere", scope: "everywhere" },
      ],
      persistentDecisionsAllowed: opts?.persistentDecisionsAllowed,
      executionTarget: opts?.executionTarget,
    },
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. getChannelApprovalPrompt
// ═══════════════════════════════════════════════════════════════════════════

describe("getChannelApprovalPrompt", () => {
  beforeEach(() => {
    pendingInteractions.clear();
  });

  test("returns null when no pending interactions exist", () => {
    const result = getChannelApprovalPrompt("conv-1");
    expect(result).toBeNull();
  });

  test("returns a prompt when a pending confirmation exists", () => {
    registerPendingConfirmation("req-1", "conv-1", "shell");

    const result = getChannelApprovalPrompt("conv-1");
    expect(result).not.toBeNull();
    expect(result!.promptText).toContain("shell");
    expect(result!.actions).toHaveLength(5);
    expect(result!.actions.map((a) => a.id)).toEqual([
      "approve_once",
      "approve_10m",
      "approve_conversation",
      "approve_always",
      "reject",
    ]);
    expect(result!.plainTextFallback).toContain("yes");
    expect(result!.plainTextFallback).toContain("always");
    expect(result!.plainTextFallback).toContain("no");
  });

  test("uses the first pending interaction when multiple exist", () => {
    registerPendingConfirmation("req-1", "conv-1", "shell");
    registerPendingConfirmation("req-2", "conv-1", "file_edit");

    const result = getChannelApprovalPrompt("conv-1");
    expect(result).not.toBeNull();
    // Should contain one of the tool names (the first pending interaction)
    expect(result!.promptText).toMatch(/shell|file_edit/);
  });

  test("excludes approve_always action when persistentDecisionsAllowed is false", () => {
    registerPendingConfirmation("req-1", "conv-1", "shell", {
      persistentDecisionsAllowed: false,
    });

    const result = getChannelApprovalPrompt("conv-1");
    expect(result).not.toBeNull();
    expect(result!.actions.map((a) => a.id)).toEqual([
      "approve_once",
      "reject",
    ]);
    expect(result!.plainTextFallback).not.toContain("always");
  });

  test("includes approve_always when persistentDecisionsAllowed is undefined", () => {
    registerPendingConfirmation("req-1", "conv-1", "shell");

    const result = getChannelApprovalPrompt("conv-1");
    expect(result).not.toBeNull();
    expect(result!.actions.map((a) => a.id)).toEqual([
      "approve_once",
      "approve_10m",
      "approve_conversation",
      "approve_always",
      "reject",
    ]);
    expect(result!.plainTextFallback).toContain("always");
  });

  test("includes approve_always when persistentDecisionsAllowed is true", () => {
    registerPendingConfirmation("req-1", "conv-1", "shell", {
      persistentDecisionsAllowed: true,
    });

    const result = getChannelApprovalPrompt("conv-1");
    expect(result).not.toBeNull();
    expect(result!.actions.map((a) => a.id)).toEqual([
      "approve_once",
      "approve_10m",
      "approve_conversation",
      "approve_always",
      "reject",
    ]);
  });

  test("does not return prompts for other conversations", () => {
    registerPendingConfirmation("req-1", "conv-1", "shell");

    const result = getChannelApprovalPrompt("conv-2");
    expect(result).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. buildApprovalUIMetadata
// ═══════════════════════════════════════════════════════════════════════════

describe("buildApprovalUIMetadata", () => {
  test("maps prompt and approval info to UI metadata", () => {
    const prompt: ChannelApprovalPrompt = {
      promptText: "Allow shell?",
      actions: [
        { id: "approve_once", label: "Approve once" },
        { id: "reject", label: "Reject" },
      ],
      plainTextFallback: "Reply yes or no.",
    };

    const approvalInfo: PendingApprovalInfo = {
      requestId: "req-abc",
      toolName: "shell",
      input: { command: "ls" },
      riskLevel: "low",
    };

    const metadata = buildApprovalUIMetadata(prompt, approvalInfo);
    expect(metadata.requestId).toBe("req-abc");
    expect(metadata.actions).toEqual(prompt.actions);
    expect(metadata.plainTextFallback).toBe("Reply yes or no.");
    expect(metadata.permissionDetails).toEqual({
      toolName: "shell",
      riskLevel: "low",
      toolInput: { command: "ls" },
    });
  });

  test("includes requesterIdentifier in permissionDetails when provided", () => {
    const prompt: ChannelApprovalPrompt = {
      promptText: "Allow deploy?",
      actions: [
        { id: "approve_once", label: "Approve once" },
        { id: "reject", label: "Reject" },
      ],
      plainTextFallback: "Reply yes or no.",
    };

    const approvalInfo: PendingApprovalInfo = {
      requestId: "req-guard",
      toolName: "deploy",
      input: { target: "prod" },
      riskLevel: "high",
    };

    const metadata = buildApprovalUIMetadata(
      prompt,
      approvalInfo,
      "alice@example.com",
    );
    expect(metadata.permissionDetails).toEqual({
      toolName: "deploy",
      riskLevel: "high",
      toolInput: { target: "prod" },
      requesterIdentifier: "alice@example.com",
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. handleChannelDecision
// ═══════════════════════════════════════════════════════════════════════════

describe("handleChannelDecision", () => {
  beforeEach(() => {
    pendingInteractions.clear();
  });

  test("returns applied: false when no pending interactions exist", () => {
    const decision: ApprovalDecisionResult = {
      action: "approve_once",
      source: "plain_text",
    };

    const result = handleChannelDecision("conv-1", decision);
    expect(result.applied).toBe(false);
    expect(result.requestId).toBeUndefined();
  });

  test('approves once via session.handleConfirmationResponse with "allow"', () => {
    registerPendingConfirmation("req-1", "conv-1", "shell");
    const interaction = pendingInteractions.get("req-1");
    const decision: ApprovalDecisionResult = {
      action: "approve_once",
      source: "plain_text",
    };

    const result = handleChannelDecision("conv-1", decision);
    expect(result.applied).toBe(true);
    expect(result.requestId).toBe("req-1");
    expect(
      interaction!.conversation!.handleConfirmationResponse,
    ).toHaveBeenCalledWith("req-1", "allow");
  });

  test('rejects via session.handleConfirmationResponse with "deny"', () => {
    registerPendingConfirmation("req-1", "conv-1", "shell");
    const interaction = pendingInteractions.get("req-1");
    const decision: ApprovalDecisionResult = {
      action: "reject",
      source: "telegram_button",
    };

    const result = handleChannelDecision("conv-1", decision);
    expect(result.applied).toBe(true);
    expect(result.requestId).toBe("req-1");
    expect(
      interaction!.conversation!.handleConfirmationResponse,
    ).toHaveBeenCalledWith("req-1", "deny");
  });

  test("uses decision.requestId to target the matching pending interaction", () => {
    registerPendingConfirmation("req-older", "conv-1", "shell");
    registerPendingConfirmation("req-newer", "conv-1", "browser");
    const newerInteraction = pendingInteractions.get("req-newer");
    const olderInteraction = pendingInteractions.get("req-older");
    const decision: ApprovalDecisionResult = {
      action: "approve_once",
      source: "telegram_button",
      requestId: "req-newer",
    };

    const result = handleChannelDecision("conv-1", decision);
    expect(result.applied).toBe(true);
    expect(result.requestId).toBe("req-newer");
    expect(
      newerInteraction!.conversation!.handleConfirmationResponse,
    ).toHaveBeenCalledWith("req-newer", "allow");
    expect(
      olderInteraction!.conversation!.handleConfirmationResponse,
    ).not.toHaveBeenCalled();
  });

  test("returns applied: false when decision.requestId does not match a pending interaction", () => {
    registerPendingConfirmation("req-1", "conv-1", "shell");
    const decision: ApprovalDecisionResult = {
      action: "approve_once",
      source: "telegram_button",
      requestId: "req-missing",
    };

    const result = handleChannelDecision("conv-1", decision);
    expect(result.applied).toBe(false);
    expect(result.requestId).toBeUndefined();
  });

  test('approve_always adds a trust rule and calls handleConfirmationResponse with "allow"', () => {
    registerPendingConfirmation("req-1", "conv-1", "shell", {
      executionTarget: "sandbox",
      allowlistOptions: [
        { label: "rm pattern", description: "rm pattern", pattern: "rm -rf *" },
      ],
      scopeOptions: [{ label: "project dir", scope: "/tmp/project" }],
    });

    const addRuleSpy = spyOn(trustStore, "addRule");
    const interaction = pendingInteractions.get("req-1");
    const decision: ApprovalDecisionResult = {
      action: "approve_always",
      source: "plain_text",
    };

    const result = handleChannelDecision("conv-1", decision);
    expect(result.applied).toBe(true);
    expect(result.requestId).toBe("req-1");

    // Trust rule added with first allowlist and scope option.
    // executionTarget is undefined for core tools like 'shell' — only
    // skill-origin tools persist it (see channel-approvals.ts).
    expect(addRuleSpy).toHaveBeenCalledWith(
      "shell",
      "rm -rf *",
      "/tmp/project",
      "allow",
      100,
      { executionTarget: undefined },
    );

    // The session is approved with "allow"
    expect(
      interaction!.conversation!.handleConfirmationResponse,
    ).toHaveBeenCalledWith("req-1", "allow");

    addRuleSpy.mockRestore();
  });

  test("approve_always does not persist rule when no allowlist/scope options are available", () => {
    registerPendingConfirmation("req-1", "conv-1", "bash", {
      allowlistOptions: [],
      scopeOptions: [],
    });

    const addRuleSpy = spyOn(trustStore, "addRule");
    const interaction = pendingInteractions.get("req-1");
    const decision: ApprovalDecisionResult = {
      action: "approve_always",
      source: "telegram_button",
    };

    const result = handleChannelDecision("conv-1", decision);

    // Rule should NOT be persisted — no blanket "**"/"everywhere" fallback
    expect(addRuleSpy).not.toHaveBeenCalled();

    // The decision should still be applied as a one-time approval
    expect(result.applied).toBe(true);
    expect(
      interaction!.conversation!.handleConfirmationResponse,
    ).toHaveBeenCalledWith("req-1", "allow");

    addRuleSpy.mockRestore();
  });

  test("approve_always does not persist rule when persistentDecisionsAllowed is false", () => {
    registerPendingConfirmation("req-1", "conv-1", "shell", {
      persistentDecisionsAllowed: false,
    });

    const addRuleSpy = spyOn(trustStore, "addRule");
    const interaction = pendingInteractions.get("req-1");
    const decision: ApprovalDecisionResult = {
      action: "approve_always",
      source: "telegram_button",
    };

    const result = handleChannelDecision("conv-1", decision);

    // Persistence blocked — rule must not be created
    expect(addRuleSpy).not.toHaveBeenCalled();

    // The current invocation should still be approved (one-time allow)
    expect(result.applied).toBe(true);
    expect(
      interaction!.conversation!.handleConfirmationResponse,
    ).toHaveBeenCalledWith("req-1", "allow");

    addRuleSpy.mockRestore();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. buildGuardianApprovalPrompt
// ═══════════════════════════════════════════════════════════════════════════

describe("buildGuardianApprovalPrompt", () => {
  test("prompt includes requester identifier and tool name", () => {
    const approvalInfo: PendingApprovalInfo = {
      requestId: "req-g1",
      toolName: "deploy",
      input: {},
      riskLevel: "high",
    };
    const prompt = buildGuardianApprovalPrompt(approvalInfo, "alice");
    expect(prompt.promptText).toContain("alice");
    expect(prompt.promptText).toContain("deploy");
  });

  test("excludes approve_always action", () => {
    const approvalInfo: PendingApprovalInfo = {
      requestId: "req-g2",
      toolName: "shell",
      input: {},
      riskLevel: "medium",
    };
    const prompt = buildGuardianApprovalPrompt(approvalInfo, "bob");
    expect(prompt.actions.map((a) => a.id)).not.toContain("approve_always");
    expect(prompt.actions.map((a) => a.id)).toContain("approve_once");
    expect(prompt.actions.map((a) => a.id)).toContain("reject");
  });

  test("plainTextFallback contains parser-compatible keywords", () => {
    const approvalInfo: PendingApprovalInfo = {
      requestId: "req-g3",
      toolName: "write_file",
      input: {},
      riskLevel: "high",
    };
    const prompt = buildGuardianApprovalPrompt(approvalInfo, "charlie");
    expect(prompt.plainTextFallback).toContain("yes");
    expect(prompt.plainTextFallback).toContain("no");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. channelSupportsRichApprovalUI
// ═══════════════════════════════════════════════════════════════════════════

describe("channelSupportsRichApprovalUI", () => {
  test("returns true for telegram", () => {
    expect(channelSupportsRichApprovalUI("telegram")).toBe(true);
  });

  test("returns false for vellum", () => {
    expect(channelSupportsRichApprovalUI("vellum")).toBe(false);
  });

  test("returns false for voice", () => {
    expect(channelSupportsRichApprovalUI("phone")).toBe(false);
  });

  test("returns true for slack", () => {
    expect(channelSupportsRichApprovalUI("slack")).toBe(true);
  });

  test("returns false for unknown channels", () => {
    expect(channelSupportsRichApprovalUI("")).toBe(false);
  });
});
