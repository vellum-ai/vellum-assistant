import { describe, expect, it } from "bun:test";

import type { DisplayMessage } from "@/domains/chat/utils/reconcile.js";

import {
  clearPendingConfirmationsFromMessages,
  dismissInteractiveSurfaces,
  newTurnId,
  parsePendingConfirmationData,
  parsePendingSecretState,
  resolvePostError,
  stopStreamingAndClearConfirmations,
} from "@/domains/chat/hooks/send-message-utils.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function msg(overrides: Partial<DisplayMessage> = {}): DisplayMessage {
  return {
    id: "msg-1",
    stableId: "stable-1",
    role: "assistant",
    content: "hello",
    toolCalls: [],
    isStreaming: false,
    ...overrides,
  } as DisplayMessage;
}

// ---------------------------------------------------------------------------
// clearPendingConfirmationsFromMessages
// ---------------------------------------------------------------------------

describe("clearPendingConfirmationsFromMessages", () => {
  it("returns the same reference when no tool calls have pendingConfirmation", () => {
    const messages = [msg(), msg({ id: "msg-2", stableId: "stable-2" })];
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
    expect(result[0]!.toolCalls![0]!.pendingConfirmation).toBeNull();
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
// stopStreamingAndClearConfirmations
// ---------------------------------------------------------------------------

describe("stopStreamingAndClearConfirmations", () => {
  it("clears isStreaming on the last assistant message", () => {
    const messages = [
      msg({ id: "msg-1", role: "user", content: "hi" }),
      msg({ id: "msg-2", role: "assistant", isStreaming: true }),
    ];
    const result = stopStreamingAndClearConfirmations(messages);
    expect(result[1]!.isStreaming).toBe(false);
  });

  it("does not touch non-assistant or non-streaming last messages", () => {
    const messages = [msg({ role: "user", content: "hi", isStreaming: false })];
    const result = stopStreamingAndClearConfirmations(messages);
    expect(result[0]!.isStreaming).toBe(false);
  });

  it("clears pending confirmations in the same pass", () => {
    const messages = [
      msg({
        role: "assistant",
        isStreaming: true,
        toolCalls: [
          { toolCallId: "tc-1", toolName: "run", pendingConfirmation: { title: "ok?" } } as never,
        ],
      }),
    ];
    const result = stopStreamingAndClearConfirmations(messages);
    expect(result[0]!.isStreaming).toBe(false);
    expect(result[0]!.toolCalls![0]!.pendingConfirmation).toBeNull();
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
