import { describe, expect, it } from "bun:test";

import type { DisplayMessage } from "@/domains/chat/types/types";

import {
  completeSubmittedSurface,
  clearPendingConfirmationsFromMessages,
  dismissInteractiveSurfaces,
  newTurnId,
  parsePendingConfirmationData,
  parsePendingSecretState,
  resolvePostError,
  shouldCleanupSupersededInteractions,
} from "@/domains/chat/utils/send-message-utils";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function msg(overrides: Partial<DisplayMessage> = {}): DisplayMessage {
  return {
    id: "stable-1",
    role: "assistant",
    content: "hello",
    toolCalls: [],
    ...overrides,
  } as DisplayMessage;
}

// ---------------------------------------------------------------------------
// clearPendingConfirmationsFromMessages
// ---------------------------------------------------------------------------

describe("clearPendingConfirmationsFromMessages", () => {
  it("returns the same reference when no tool calls have pendingConfirmation", () => {
    const messages = [msg(), msg({ id: "msg-2" })];
    expect(clearPendingConfirmationsFromMessages(messages)).toBe(messages);
  });

  it("clears pendingConfirmation from tool calls", () => {
    const messages = [
      msg({
        toolCalls: [
          { toolCallId: "tc-1", toolName: "run", pendingConfirmation: { title: "Confirm?" } } as never,
        ],
      }),
    ];
    const result = clearPendingConfirmationsFromMessages(messages);
    expect(result).not.toBe(messages);
    expect(result[0]!.toolCalls![0]!.pendingConfirmation).toBeUndefined();
  });

  it("leaves tool calls without pendingConfirmation untouched", () => {
    const tc = { toolCallId: "tc-1", toolName: "run" };
    const messages = [msg({ toolCalls: [tc as never] })];
    const result = clearPendingConfirmationsFromMessages(messages);
    expect(result).toBe(messages);
  });
});

// ---------------------------------------------------------------------------
// dismissInteractiveSurfaces
// ---------------------------------------------------------------------------

describe("dismissInteractiveSurfaces", () => {
  it("returns the same reference when no interactive surfaces exist", () => {
    const messages = [msg()];
    const { updatedMessages, dismissedIds } = dismissInteractiveSurfaces(messages, messages);
    expect(updatedMessages).toBe(messages);
    expect(dismissedIds.size).toBe(0);
  });

  it("removes interactive surfaces from messages", () => {
    const surface = {
      surfaceId: "s-1",
      surfaceType: "form",
      completed: false,
      actions: [{ label: "Submit" }],
    };
    const messagesWithSurface = [
      msg({ surfaces: [surface as never] }),
    ];
    const { updatedMessages, dismissedIds } = dismissInteractiveSurfaces(
      messagesWithSurface,
      messagesWithSurface,
    );
    expect(dismissedIds.has("s-1")).toBe(true);
    expect(updatedMessages[0]!.surfaces).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// shouldCleanupSupersededInteractions
// ---------------------------------------------------------------------------

describe("shouldCleanupSupersededInteractions", () => {
  it("skips cleanup when the rendered UI has no supersedable interaction", () => {
    expect(
      shouldCleanupSupersededInteractions({
        hasPendingConfirmation: false,
        hasUncompletedVisibleSurface: false,
      }),
    ).toBe(false);
  });

  it("runs cleanup when the rendered UI has an interactive surface", () => {
    expect(
      shouldCleanupSupersededInteractions({
        hasPendingConfirmation: false,
        hasUncompletedVisibleSurface: true,
      }),
    ).toBe(true);
  });

  it("runs cleanup when there is no rendered UI context", () => {
    expect(shouldCleanupSupersededInteractions(null)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// completeSubmittedSurface
// ---------------------------------------------------------------------------

describe("completeSubmittedSurface", () => {
  it("optimistically completes choice surfaces after submit", () => {
    const messages = [
      msg({
        surfaces: [
          {
            surfaceId: "s-choice",
            surfaceType: "choice",
            completed: false,
            data: {},
            actions: [{ id: "inbox", label: "Clean up my inbox" }],
          } as never,
        ],
      }),
    ];

    const result = completeSubmittedSurface(messages, "s-choice", "inbox");

    expect(result).not.toBe(messages);
    expect(result[0]!.surfaces![0]!.completed).toBe(true);
    expect(result[0]!.surfaces![0]!.completionSummary).toBe(
      "Clean up my inbox",
    );
  });

  it("leaves non-completing surfaces unchanged", () => {
    const messages = [
      msg({
        surfaces: [
          {
            surfaceId: "s-copy",
            surfaceType: "copy_block",
            completed: false,
            data: {},
          } as never,
        ],
      }),
    ];

    expect(completeSubmittedSurface(messages, "s-copy", "copy")).toBe(messages);
  });
});

// ---------------------------------------------------------------------------
// resolvePostError
// ---------------------------------------------------------------------------

describe("resolvePostError", () => {
  it("returns the known error message for a recognized code", () => {
    const result = resolvePostError("rate_limit_exceeded", undefined, "fallback");
    expect(result).toBe("Too many requests. Please wait a moment and try again.");
  });

  it("returns the detail when the code is unrecognized", () => {
    const result = resolvePostError("unknown_code", "Some detail", "fallback");
    expect(result).toBe("Some detail");
  });

  it("returns the fallback when both code and detail are missing", () => {
    const result = resolvePostError(null, undefined, "fallback");
    expect(result).toBe("fallback");
  });

  it("returns the fallback when code is empty and detail is undefined", () => {
    const result = resolvePostError("", undefined, "fallback");
    expect(result).toBe("fallback");
  });
});

// ---------------------------------------------------------------------------
// parsePendingSecretState
// ---------------------------------------------------------------------------

describe("parsePendingSecretState", () => {
  it("parses a fully-populated secret payload", () => {
    const raw = {
      requestId: "req-1",
      label: "API Key",
      service: "slack_channel",
      field: "app_token",
      description: "Enter your key",
      placeholder: "sk-...",
      allowOneTimeSend: true,
      allowedTools: ["tool-a"],
      allowedDomains: ["example.com"],
      purpose: "auth",
    };
    const result = parsePendingSecretState(raw);
    expect(result).toEqual(raw);
  });

  it("preserves service and field structured identifiers", () => {
    const result = parsePendingSecretState({
      requestId: "req-1",
      service: "slack_channel",
      field: "app_token",
    });
    expect(result.service).toBe("slack_channel");
    expect(result.field).toBe("app_token");
  });

  it("defaults requestId to empty string when missing", () => {
    const result = parsePendingSecretState({});
    expect(result.requestId).toBe("");
  });

  it("returns undefined for optional fields when absent", () => {
    const result = parsePendingSecretState({ requestId: "req-2" });
    expect(result.label).toBeUndefined();
    expect(result.description).toBeUndefined();
    expect(result.placeholder).toBeUndefined();
    expect(result.allowOneTimeSend).toBeUndefined();
    expect(result.allowedTools).toBeUndefined();
    expect(result.allowedDomains).toBeUndefined();
    expect(result.purpose).toBeUndefined();
    expect(result.service).toBeUndefined();
    expect(result.field).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// parsePendingConfirmationData
// ---------------------------------------------------------------------------

describe("parsePendingConfirmationData", () => {
  it("parses a fully-populated confirmation payload", () => {
    const raw = {
      requestId: "req-1",
      title: "Confirm action",
      description: "Are you sure?",
      confirmLabel: "Yes",
      denyLabel: "No",
      toolName: "delete_file",
      riskLevel: "high",
      riskReason: "Irreversible",
      persistentDecisionsAllowed: true,
      input: { path: "/tmp" },
      toolUseId: "tu-1",
    };
    const { confData, state } = parsePendingConfirmationData(raw);

    expect(state.requestId).toBe("req-1");
    expect(state.confirmLabel).toBe("Yes");
    expect(state.denyLabel).toBe("No");
    expect(state.toolName).toBe("delete_file");

    expect(confData.requestId).toBe("req-1");
    expect(confData.toolUseId).toBe("tu-1");
  });

  it("defaults requestId to empty string when missing", () => {
    const { state } = parsePendingConfirmationData({});
    expect(state.requestId).toBe("");
  });
});

// ---------------------------------------------------------------------------
// newTurnId
// ---------------------------------------------------------------------------

describe("newTurnId", () => {
  it("generates a string starting with 'turn-'", () => {
    expect(newTurnId().startsWith("turn-")).toBe(true);
  });

  it("generates unique IDs on successive calls", () => {
    const ids = new Set(Array.from({ length: 50 }, () => newTurnId()));
    expect(ids.size).toBe(50);
  });
});
