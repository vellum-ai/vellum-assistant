import { afterEach, describe, expect, it, beforeEach } from "bun:test";

import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import { useInteractionStore } from "@/domains/chat/interaction-store";
import type { DisplayMessage } from "@/domains/chat/types/types";
import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";
import { textBody } from "@/domains/chat/utils/message-test-helpers";
import { makeCtx } from "@/domains/chat/utils/stream-handlers/test-helpers";
import {
  handleSecretRequest,
  handleConfirmationRequest,
  handleContactRequest,
  handleInteractionResolved,
} from "@/domains/chat/utils/stream-handlers/interaction-handlers";

function seedSnapshot(messages: DisplayMessage[]): void {
  useChatSessionStore.setState({
    snapshot: {
      messages,
      seq: null,
      hasMore: false,
      oldestTimestamp: null,
      oldestMessageId: null,
    },
  });
}

function runningToolCall(id: string): ChatMessageToolCall {
  return { id, name: "bash", input: {} };
}

beforeEach(() => {
  useInteractionStore.getState().resetAll();
  useChatSessionStore.getState().deleteConfirmationToolCall("cr-1");
});

afterEach(() => {
  useChatSessionStore.setState({ snapshot: null });
});

describe("handleSecretRequest", () => {
  it("dispatches SECRET_REQUEST turn event and updates interaction store", () => {
    const ctx = makeCtx();
    handleSecretRequest(
      {
        type: "secret_request",
        requestId: "sr-1",
        service: "openai",
        field: "api_key",
        label: "API Key",
      },
      ctx,
    );
    expect(ctx.turnActions.onSecretRequest).toHaveBeenCalled();
    const state = useInteractionStore.getState();
    expect(state.pendingSecret).toMatchObject({
      requestId: "sr-1",
      label: "API Key",
    });
  });
});

describe("handleConfirmationRequest", () => {
  it("dispatches CONFIRMATION_REQUEST turn event and updates interaction store", () => {
    const ctx = makeCtx();
    handleConfirmationRequest(
      {
        type: "confirmation_request",
        requestId: "cr-1",
        toolName: "bash",
        input: { command: "ls" },
        riskLevel: "low",
        allowlistOptions: [],
        scopeOptions: [],
      },
      ctx,
    );
    expect(ctx.turnActions.onConfirmationRequest).toHaveBeenCalled();
    const state = useInteractionStore.getState();
    expect(state.pendingConfirmation).toMatchObject({ requestId: "cr-1" });
  });

  it("wires the interaction store to the matched tool call (reducer folds the marker)", () => {
    // The reducer attaches the inline marker onto the snapshot (covered in
    // rolling-snapshot.test.ts); the handler only derives the matched tool-call id
    // read-only to wire the interaction store.
    seedSnapshot([
      {
        id: "a-1",
        role: "assistant",
        ...textBody(""),
        timestamp: 1,
        toolCalls: [runningToolCall("tc-1")],
      },
    ]);
    const ctx = makeCtx();
    handleConfirmationRequest(
      {
        type: "confirmation_request",
        requestId: "cr-1",
        toolName: "bash",
        input: { command: "ls" },
        riskLevel: "low",
        allowlistOptions: [],
        scopeOptions: [],
      },
      ctx,
    );

    expect(
      useInteractionStore.getState().inlineConfirmationToolCallId,
    ).toBe("tc-1");
    expect(ctx.setConfirmationToolCall).toHaveBeenCalledWith("cr-1", "tc-1");
  });
});

describe("handleInteractionResolved", () => {
  it("retires the active confirmation's interaction-store state when it resolves", () => {
    // The reducer clears the inline marker on the snapshot (covered in
    // rolling-snapshot.test.ts); the handler releases the interaction-store
    // bookkeeping.
    useInteractionStore.getState().showConfirmation({
      requestId: "cr-1",
      toolName: "acp_spawn",
      riskLevel: "high",
      input: {},
    });
    useInteractionStore.getState().setInlineConfirmationToolCallId("tc-1");
    useChatSessionStore.getState().setConfirmationToolCall("cr-1", "tc-1");

    handleInteractionResolved({
      type: "interaction_resolved",
      requestId: "cr-1",
      conversationId: "conv-1",
      kind: "confirmation",
      state: "cancelled",
    });

    const interaction = useInteractionStore.getState();
    expect(interaction.pendingConfirmation).toBeNull();
    expect(interaction.inlineConfirmationToolCallId).toBeNull();
    expect(
      useChatSessionStore.getState().confirmationToolCallMap.has("cr-1"),
    ).toBe(false);
  });

  it("leaves a non-matching confirmation untouched", () => {
    useInteractionStore.getState().showConfirmation({
      requestId: "cr-1",
      toolName: "acp_spawn",
      riskLevel: "high",
      input: {},
    });

    handleInteractionResolved({
      type: "interaction_resolved",
      requestId: "other-request",
      conversationId: "conv-1",
      kind: "confirmation",
      state: "cancelled",
    });

    expect(
      useInteractionStore.getState().pendingConfirmation?.requestId,
    ).toBe("cr-1");
  });

  it("ignores non-confirmation interaction kinds", () => {
    useInteractionStore.getState().showConfirmation({
      requestId: "cr-1",
      toolName: "acp_spawn",
      riskLevel: "high",
      input: {},
    });

    handleInteractionResolved({
      type: "interaction_resolved",
      requestId: "cr-1",
      conversationId: "conv-1",
      kind: "host_bash",
      state: "cancelled",
    });

    // Host-proxy steps own their own lifecycle and must not clear the card.
    expect(
      useInteractionStore.getState().pendingConfirmation?.requestId,
    ).toBe("cr-1");
  });
});

describe("handleContactRequest", () => {
  it("dispatches CONTACT_REQUEST turn event and updates interaction store", () => {
    const ctx = makeCtx();
    handleContactRequest(
      { type: "contact_request", requestId: "ctc-1", channel: "email" },
      ctx,
    );
    expect(ctx.turnActions.onContactRequest).toHaveBeenCalled();
    const state = useInteractionStore.getState();
    expect(state.pendingContactRequest).toMatchObject({ requestId: "ctc-1" });
  });
});
