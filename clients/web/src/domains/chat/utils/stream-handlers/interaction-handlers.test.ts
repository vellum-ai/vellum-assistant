import { afterEach, describe, expect, it, beforeEach, mock } from "bun:test";

import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import { useInteractionStore } from "@/domains/chat/interaction-store";
import type { DisplayMessage } from "@/domains/chat/types/types";
import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";
import { textBody } from "@/domains/chat/utils/message-test-helpers";
import { makeCtx } from "@/domains/chat/utils/stream-handlers/test-helpers";

/**
 * The host capability the confirmation handler reaches for, stubbed so the
 * raise is observable. Off Electron the real one no-ops, which would make
 * "raises the window" and "does nothing at all" the same passing test.
 *
 * Declared before the handlers are imported, so the module under test binds to
 * the stub: same shape as `start-voice-request.test.ts`, the other caller of
 * this seam.
 */
const ensureMainWindowVisibleMock = mock(() => Promise.resolve());
mock.module("@/runtime/main-window", () => ({
  ensureMainWindowVisible: ensureMainWindowVisibleMock,
}));

const {
  handleSecretRequest,
  handleConfirmationRequest,
  handleContactRequest,
  handleContactFormClosed,
  handleInteractionResolved,
} = await import("@/domains/chat/utils/stream-handlers/interaction-handlers");

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
  ensureMainWindowVisibleMock.mockClear();
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

  it("wires the interaction store to the tool call the confirmation names", () => {
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
        toolUseId: "tc-1",
      },
      ctx,
    );

    expect(useInteractionStore.getState().inlineConfirmationToolCallId).toBe(
      "tc-1",
    );
    expect(ctx.setConfirmationToolCall).toHaveBeenCalledWith("cr-1", "tc-1");
  });

  it("wires nothing when the confirmation names no tool call", () => {
    // `toolUseId` is absent exactly when the prompt belongs to no tool call
    // (ACP route approvals), so there is nothing to wire. Binding it to
    // whichever call happens to be running hides the prompt whenever that
    // call is one the transcript does not draw.
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
    ).toBeNull();
    expect(ctx.setConfirmationToolCall).not.toHaveBeenCalled();
  });

  /**
   * The card that answers a confirmation is drawn in the app's window, and the
   * turn that raised it need not have been started there: a message typed on
   * the companion, or a scheduled run, leaves the window behind whatever the
   * user is working in, and a request nobody can see is a run that has stopped
   * for no visible reason.
   */
  it("brings the app forward so the request can be answered", () => {
    handleConfirmationRequest(
      {
        type: "confirmation_request",
        requestId: "cr-1",
        toolName: "bash",
        input: { command: "rm -rf ." },
        riskLevel: "high",
        allowlistOptions: [],
        scopeOptions: [],
      },
      makeCtx(),
    );

    expect(ensureMainWindowVisibleMock).toHaveBeenCalledTimes(1);
  });
});

/**
 * The other prompts are deliberately not raises. A secret is asked for at the
 * point the user set up an integration, and a contact request is a field on a
 * card that is already on screen, so neither is the assistant stopped on a
 * question the user cannot see.
 */
describe("prompts that do not raise the window", () => {
  it("leaves the window where it is for a secret request", () => {
    handleSecretRequest(
      {
        type: "secret_request",
        requestId: "sr-1",
        service: "openai",
        field: "api_key",
        label: "API Key",
      },
      makeCtx(),
    );

    expect(ensureMainWindowVisibleMock).not.toHaveBeenCalled();
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

    expect(useInteractionStore.getState().pendingConfirmation?.requestId).toBe(
      "cr-1",
    );
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
    expect(useInteractionStore.getState().pendingConfirmation?.requestId).toBe(
      "cr-1",
    );
  });

  it("retires a question card the daemon settled without the user", () => {
    // Timeout, abort, supersession, and daemon restart all settle the prompt
    // as "cancelled". None of them produce an answer, so this event is the
    // only signal the card has stopped being answerable.
    useInteractionStore
      .getState()
      .showQuestion({ requestId: "q-req-1", entries: [] });

    handleInteractionResolved({
      type: "interaction_resolved",
      requestId: "q-req-1",
      conversationId: "conv-1",
      kind: "question",
      state: "cancelled",
    });

    expect(useInteractionStore.getState().pendingQuestion).toBeNull();
  });

  it("retires a question card on the answered state too", () => {
    // The channel paths (a Telegram option tap, a request-code reply) resolve
    // the prompt as "answered" while the web card is still open.
    useInteractionStore
      .getState()
      .showQuestion({ requestId: "q-req-1", entries: [] });

    handleInteractionResolved({
      type: "interaction_resolved",
      requestId: "q-req-1",
      conversationId: "conv-1",
      kind: "question",
      state: "answered",
    });

    expect(useInteractionStore.getState().pendingQuestion).toBeNull();
  });

  it("leaves a question card raised for a different requestId alone", () => {
    useInteractionStore
      .getState()
      .showQuestion({ requestId: "q-req-2", entries: [] });

    handleInteractionResolved({
      type: "interaction_resolved",
      requestId: "q-req-1",
      conversationId: "conv-1",
      kind: "question",
      state: "cancelled",
    });

    expect(useInteractionStore.getState().pendingQuestion?.requestId).toBe(
      "q-req-2",
    );
  });

  it("does not disturb a pending confirmation when a question resolves", () => {
    useInteractionStore.getState().showConfirmation({
      requestId: "cr-1",
      toolName: "bash",
      riskLevel: "high",
      input: {},
    });
    useInteractionStore
      .getState()
      .showQuestion({ requestId: "q-req-1", entries: [] });

    handleInteractionResolved({
      type: "interaction_resolved",
      requestId: "q-req-1",
      conversationId: "conv-1",
      kind: "question",
      state: "cancelled",
    });

    expect(useInteractionStore.getState().pendingQuestion).toBeNull();
    expect(useInteractionStore.getState().pendingConfirmation?.requestId).toBe(
      "cr-1",
    );
  });
});

describe("handleContactRequest", () => {
  it("raises the card without touching the turn", () => {
    const ctx = makeCtx();
    handleContactRequest(
      { type: "contact_request", requestId: "ctc-1", channel: "email" },
      ctx,
    );

    const state = useInteractionStore.getState();
    expect(state.pendingContactRequest).toMatchObject({ requestId: "ctc-1" });
    // The event carries no conversation, so the only turn available is
    // whichever the guardian is viewing. A form raised by a background command
    // would park a conversation that is not waiting on it, and show an
    // unrelated turn as awaiting input.
    expect(ctx.turnActions.onContactRequest).not.toHaveBeenCalled();
  });
});

describe("handleContactFormClosed", () => {
  beforeEach(() => {
    useInteractionStore.setState(useInteractionStore.getInitialState(), true);
  });

  function raiseRecordForm(requestId: string) {
    useInteractionStore
      .getState()
      .showContactRecordRequest({ requestId, operation: "create" });
  }

  it("retires the card on a client that did not answer", () => {
    raiseRecordForm("r1");

    handleContactFormClosed({
      type: "contact_form_closed",
      requestId: "r1",
      reason: "answered",
    });

    expect(
      useInteractionStore.getState().pendingContactRecordRequest,
    ).toBeNull();
  });

  it("gives a card with a submission on the wire a moment before retiring it", () => {
    raiseRecordForm("r1");
    useInteractionStore
      .getState()
      .claimSubmission("contactRecordRequest", "r1");

    // The gateway resolves the form before its HTTP response returns, so this
    // can arrive while the submission is still on the wire.
    handleContactFormClosed({
      type: "contact_form_closed",
      requestId: "r1",
      reason: "answered",
    });

    expect(
      useInteractionStore.getState().pendingContactRecordRequest?.requestId,
    ).toBe("r1");
    // Not marked answered: this broadcast names the form, and every client
    // submitting it concurrently matches, including the ones that lost. Only
    // this client's own response can say it wrote anything.
    expect(useInteractionStore.getState().contactRecordRequestAccepted).toBe(
      false,
    );
  });

  it("retires a failed form on the client that submitted it", () => {
    raiseRecordForm("r1");
    useInteractionStore
      .getState()
      .claimSubmission("contactRecordRequest", "r1");

    // A write that failed closes the form server-side, so the card has nothing
    // left to submit to and must not stay up offering to retry.
    handleContactFormClosed({
      type: "contact_form_closed",
      requestId: "r1",
      reason: "cancelled",
    });

    expect(
      useInteractionStore.getState().pendingContactRecordRequest,
    ).toBeNull();
  });

  it("ignores a closure for a form this client is not showing", () => {
    raiseRecordForm("r1");

    handleContactFormClosed({
      type: "contact_form_closed",
      requestId: "other",
      reason: "timed_out",
    });

    expect(
      useInteractionStore.getState().pendingContactRecordRequest?.requestId,
    ).toBe("r1");
  });
});
