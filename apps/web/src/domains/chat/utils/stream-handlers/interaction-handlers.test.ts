import { describe, expect, it, beforeEach } from "bun:test";

import { useInteractionStore } from "@/domains/chat/interaction-store";
import { makeCtx } from "@/domains/chat/utils/stream-handlers/test-helpers";
import {
  handleSecretRequest,
  handleConfirmationRequest,
  handleContactRequest,
} from "@/domains/chat/utils/stream-handlers/interaction-handlers";

beforeEach(() => {
  useInteractionStore.getState().resetAll();
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
    expect(ctx.setMessages).toHaveBeenCalled();
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
