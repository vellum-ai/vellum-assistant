/**
 * Tests for render-time enrichment of history tool calls with confirmation
 * context: derived scope ladders for scope-aware tools and outstanding prompts
 * read from the pending-interactions registry.
 */
import { afterEach, describe, expect, test } from "bun:test";

import type { ConversationMessageToolCall } from "../../api/responses/conversation-message.js";
import { clear, register } from "../pending-interactions.js";
import {
  collectPendingConfirmations,
  enrichToolCallsWithConfirmation,
} from "./tool-call-confirmation-enrichment.js";

const WORKSPACE = "/home/user/project";

function toolCall(
  overrides: Partial<ConversationMessageToolCall>,
): ConversationMessageToolCall {
  return {
    name: "file_read",
    input: {},
    ...overrides,
  };
}

afterEach(() => {
  clear();
});

describe("collectPendingConfirmations", () => {
  test("keys confirmation interactions by toolUseId", () => {
    // GIVEN a confirmation interaction registered for a conversation with a
    // tool-use id and confirmation details
    register("req-1", {
      conversationId: "conv-1",
      kind: "confirmation",
      toolUseId: "tool-abc",
      confirmationDetails: {
        toolName: "file_read",
        input: { path: "/home/user/project/a.txt" },
        riskLevel: "low",
        allowlistOptions: [],
        scopeOptions: [],
      },
    });

    // WHEN we collect the conversation's pending confirmations
    const byToolUseId = collectPendingConfirmations("conv-1");

    // THEN the interaction is keyed by its tool-use id
    expect(byToolUseId.size).toBe(1);
    expect(byToolUseId.get("tool-abc")?.requestId).toBe("req-1");
  });

  test("ignores interactions lacking a toolUseId or confirmation details", () => {
    // GIVEN a confirmation without a toolUseId AND a non-confirmation
    // interaction in the same conversation
    register("req-no-tool", {
      conversationId: "conv-2",
      kind: "confirmation",
      confirmationDetails: {
        toolName: "file_read",
        input: {},
        riskLevel: "low",
        allowlistOptions: [],
        scopeOptions: [],
      },
    });
    register("req-secret", {
      conversationId: "conv-2",
      kind: "secret",
      toolUseId: "tool-xyz",
    });

    // WHEN we collect the conversation's pending confirmations
    const byToolUseId = collectPendingConfirmations("conv-2");

    // THEN neither is included — one has no toolUseId, the other is not a
    // confirmation
    expect(byToolUseId.size).toBe(0);
  });
});

describe("enrichToolCallsWithConfirmation", () => {
  test("derives the scope ladder for scope-aware tools", () => {
    // GIVEN a completed scope-aware tool call with no registry entry
    const calls = [toolCall({ id: "tool-1", name: "file_read" })];

    // WHEN we enrich it
    const [enriched] = enrichToolCallsWithConfirmation(calls, {
      workspaceDir: WORKSPACE,
      pendingConfirmations: new Map(),
    });

    // THEN the scope ladder is derived from the workspace and tool name
    expect(enriched?.scopeOptions?.[0]).toEqual({
      label: WORKSPACE,
      scope: WORKSPACE,
    });
    // AND no pending confirmation is stamped
    expect(enriched?.pendingConfirmation).toBeUndefined();
  });

  test("leaves non-scope-aware tool calls untouched", () => {
    // GIVEN a tool call for a tool that has no scope ladder
    const original = toolCall({ id: "tool-2", name: "web_search" });

    // WHEN we enrich it with no matching registry entry
    const [enriched] = enrichToolCallsWithConfirmation([original], {
      workspaceDir: WORKSPACE,
      pendingConfirmations: new Map(),
    });

    // THEN the tool call is returned unchanged (same reference)
    expect(enriched).toBe(original);
  });

  test("stamps the pending confirmation when the registry has a match", () => {
    // GIVEN a registry entry matching the tool call by id
    const pendingConfirmations = collectPendingConfirmationsFixture();
    const calls = [toolCall({ id: "tool-abc", name: "file_read" })];

    // WHEN we enrich it
    const [enriched] = enrichToolCallsWithConfirmation(calls, {
      workspaceDir: WORKSPACE,
      pendingConfirmations,
    });

    // THEN the outstanding prompt is projected onto the tool call
    expect(enriched?.pendingConfirmation?.requestId).toBe("req-1");
    expect(enriched?.pendingConfirmation?.toolName).toBe("file_read");
    expect(enriched?.pendingConfirmation?.riskLevel).toBe("high");
    // AND the directory scope ladder carries through from the registry so a
    // restored prompt offers the same scope the live event did
    expect(enriched?.pendingConfirmation?.directoryScopeOptions).toEqual([
      { label: "Anywhere in project/", scope: "/home/user/project" },
    ]);
    // AND the derived scope ladder is still present
    expect(enriched?.scopeOptions?.length).toBeGreaterThan(0);
  });
});

function collectPendingConfirmationsFixture() {
  register("req-1", {
    conversationId: "conv-fixture",
    kind: "confirmation",
    toolUseId: "tool-abc",
    confirmationDetails: {
      toolName: "file_read",
      input: { path: "/home/user/project/a.txt" },
      riskLevel: "high",
      allowlistOptions: [],
      scopeOptions: [],
      directoryScopeOptions: [
        { label: "Anywhere in project/", scope: "/home/user/project" },
      ],
    },
  });
  return collectPendingConfirmations("conv-fixture");
}
