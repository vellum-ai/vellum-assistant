import { describe, expect, it } from "bun:test";

import { makeCtx } from "@/domains/chat/utils/stream-handlers/test-helpers.js";
import {
  handleSecretRequest,
  handleConfirmationRequest,
  handleContactRequest,
} from "@/domains/chat/utils/stream-handlers/interaction-handlers.js";

describe("handleSecretRequest", () => {
  it("dispatches SECRET_REQUEST and SHOW_SECRET", () => {
    const ctx = makeCtx();
    handleSecretRequest(
      { type: "secret_request", requestId: "sr-1", label: "API Key" },
      ctx,
    );
    expect(ctx.turnActions.onSecretRequest).toHaveBeenCalled();
    expect(ctx.dispatchInteraction).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "SHOW_SECRET",
        payload: expect.objectContaining({ requestId: "sr-1" }),
      }),
    );
  });
});

describe("handleConfirmationRequest", () => {
  it("dispatches CONFIRMATION_REQUEST and SHOW_CONFIRMATION", () => {
    const ctx = makeCtx();
    handleConfirmationRequest(
      { type: "confirmation_request", requestId: "cr-1", title: "Allow?" },
      ctx,
    );
    expect(ctx.turnActions.onConfirmationRequest).toHaveBeenCalled();
    expect(ctx.dispatchInteraction).toHaveBeenCalledWith(
      expect.objectContaining({ type: "SHOW_CONFIRMATION" }),
    );
    expect(ctx.setMessages).toHaveBeenCalled();
  });
});

describe("handleContactRequest", () => {
  it("dispatches CONTACT_REQUEST and SHOW_CONTACT_REQUEST", () => {
    const ctx = makeCtx();
    handleContactRequest(
      { type: "contact_request", requestId: "ctc-1", channel: "email" },
      ctx,
    );
    expect(ctx.turnActions.onContactRequest).toHaveBeenCalled();
    expect(ctx.dispatchInteraction).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "SHOW_CONTACT_REQUEST",
        payload: expect.objectContaining({ requestId: "ctc-1" }),
      }),
    );
  });
});
