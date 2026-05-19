import { describe, expect, it } from "bun:test";
import {
  INITIAL_INTERACTION_STATE,
  hasActiveInteraction,
  interactionReducer,
  type InteractionState,
} from "@/domains/chat/lib/interaction-state-machine.js";

describe("interactionReducer", () => {
  // ----- Secret flow -----
  describe("secret flow", () => {
    it("SHOW_SECRET sets pendingSecret and resets submit/saved flags", () => {
      const payload = { requestId: "r1", label: "API Key" };
      const next = interactionReducer(INITIAL_INTERACTION_STATE, {
        type: "SHOW_SECRET",
        payload,
      });
      expect(next.pendingSecret).toEqual(payload);
      expect(next.isSubmittingSecret).toBe(false);
      expect(next.secretSaved).toBe(false);
    });

    it("SUBMIT_SECRET_START sets isSubmittingSecret", () => {
      const state: InteractionState = {
        ...INITIAL_INTERACTION_STATE,
        pendingSecret: { requestId: "r1" },
      };
      const next = interactionReducer(state, { type: "SUBMIT_SECRET_START" });
      expect(next.isSubmittingSecret).toBe(true);
    });

    it("SUBMIT_SECRET_END clears isSubmittingSecret and sets saved flag", () => {
      const state: InteractionState = {
        ...INITIAL_INTERACTION_STATE,
        pendingSecret: { requestId: "r1" },
        isSubmittingSecret: true,
      };
      const next = interactionReducer(state, {
        type: "SUBMIT_SECRET_END",
        saved: true,
      });
      expect(next.isSubmittingSecret).toBe(false);
      expect(next.secretSaved).toBe(true);
    });

    it("DISMISS_SECRET clears pendingSecret and isSubmittingSecret", () => {
      const state: InteractionState = {
        ...INITIAL_INTERACTION_STATE,
        pendingSecret: { requestId: "r1" },
        isSubmittingSecret: true,
      };
      const next = interactionReducer(state, { type: "DISMISS_SECRET" });
      expect(next.pendingSecret).toBeNull();
      expect(next.isSubmittingSecret).toBe(false);
    });

    it("UPDATE_SECRET applies patch when requestId matches", () => {
      const state: InteractionState = {
        ...INITIAL_INTERACTION_STATE,
        pendingSecret: { requestId: "r1", label: "old" },
      };
      const next = interactionReducer(state, {
        type: "UPDATE_SECRET",
        requestId: "r1",
        patch: { label: "new" },
      });
      expect(next.pendingSecret?.label).toBe("new");
    });

    it("UPDATE_SECRET is no-op when requestId does not match", () => {
      const state: InteractionState = {
        ...INITIAL_INTERACTION_STATE,
        pendingSecret: { requestId: "r1", label: "old" },
      };
      const next = interactionReducer(state, {
        type: "UPDATE_SECRET",
        requestId: "r2",
        patch: { label: "new" },
      });
      expect(next).toBe(state);
    });

    it("UPDATE_SECRET is no-op when no pending secret", () => {
      const next = interactionReducer(INITIAL_INTERACTION_STATE, {
        type: "UPDATE_SECRET",
        requestId: "r1",
        patch: { label: "new" },
      });
      expect(next).toBe(INITIAL_INTERACTION_STATE);
    });
  });

  // ----- Confirmation flow -----
  describe("confirmation flow", () => {
    it("SHOW_CONFIRMATION sets pendingConfirmation", () => {
      const payload = { requestId: "c1", title: "Allow?" };
      const next = interactionReducer(INITIAL_INTERACTION_STATE, {
        type: "SHOW_CONFIRMATION",
        payload,
      });
      expect(next.pendingConfirmation).toEqual(payload);
      expect(next.isSubmittingConfirmation).toBe(false);
    });

    it("SUBMIT_CONFIRMATION_START / END toggle flag", () => {
      const state: InteractionState = {
        ...INITIAL_INTERACTION_STATE,
        pendingConfirmation: { requestId: "c1" },
      };
      const started = interactionReducer(state, {
        type: "SUBMIT_CONFIRMATION_START",
      });
      expect(started.isSubmittingConfirmation).toBe(true);

      const ended = interactionReducer(started, {
        type: "SUBMIT_CONFIRMATION_END",
      });
      expect(ended.isSubmittingConfirmation).toBe(false);
    });

    it("DISMISS_CONFIRMATION clears pendingConfirmation", () => {
      const state: InteractionState = {
        ...INITIAL_INTERACTION_STATE,
        pendingConfirmation: { requestId: "c1" },
        isSubmittingConfirmation: true,
      };
      const next = interactionReducer(state, {
        type: "DISMISS_CONFIRMATION",
      });
      expect(next.pendingConfirmation).toBeNull();
      expect(next.isSubmittingConfirmation).toBe(false);
    });

    it("DISMISS_CONFIRMATION_IF_MATCHES clears when requestId matches", () => {
      const state: InteractionState = {
        ...INITIAL_INTERACTION_STATE,
        pendingConfirmation: { requestId: "c1" },
        isSubmittingConfirmation: true,
      };
      const next = interactionReducer(state, {
        type: "DISMISS_CONFIRMATION_IF_MATCHES",
        requestId: "c1",
      });
      expect(next.pendingConfirmation).toBeNull();
      expect(next.isSubmittingConfirmation).toBe(false);
    });

    it("DISMISS_CONFIRMATION_IF_MATCHES is no-op when requestId does not match", () => {
      const state: InteractionState = {
        ...INITIAL_INTERACTION_STATE,
        pendingConfirmation: { requestId: "c1" },
        isSubmittingConfirmation: true,
      };
      const next = interactionReducer(state, {
        type: "DISMISS_CONFIRMATION_IF_MATCHES",
        requestId: "c2",
      });
      expect(next).toBe(state);
    });

    it("DISMISS_CONFIRMATION_IF_MATCHES is no-op when no pending confirmation", () => {
      const next = interactionReducer(INITIAL_INTERACTION_STATE, {
        type: "DISMISS_CONFIRMATION_IF_MATCHES",
        requestId: "c1",
      });
      expect(next).toBe(INITIAL_INTERACTION_STATE);
    });

    it("UPDATE_CONFIRMATION applies patch when requestId matches", () => {
      const state: InteractionState = {
        ...INITIAL_INTERACTION_STATE,
        pendingConfirmation: { requestId: "c1", title: "old" },
      };
      const next = interactionReducer(state, {
        type: "UPDATE_CONFIRMATION",
        requestId: "c1",
        patch: { title: "new" },
      });
      expect(next.pendingConfirmation?.title).toBe("new");
    });

    it("UPDATE_CONFIRMATION is no-op when requestId does not match", () => {
      const state: InteractionState = {
        ...INITIAL_INTERACTION_STATE,
        pendingConfirmation: { requestId: "c1", title: "old" },
      };
      const next = interactionReducer(state, {
        type: "UPDATE_CONFIRMATION",
        requestId: "c2",
        patch: { title: "new" },
      });
      expect(next).toBe(state);
    });

    it("SET_INLINE_CONFIRMATION_TOOL_CALL_ID sets the id", () => {
      const next = interactionReducer(INITIAL_INTERACTION_STATE, {
        type: "SET_INLINE_CONFIRMATION_TOOL_CALL_ID",
        toolCallId: "tc-1",
      });
      expect(next.inlineConfirmationToolCallId).toBe("tc-1");
    });

    it("SET_INLINE_CONFIRMATION_TOOL_CALL_ID clears the id with null", () => {
      const state: InteractionState = {
        ...INITIAL_INTERACTION_STATE,
        inlineConfirmationToolCallId: "tc-1",
      };
      const next = interactionReducer(state, {
        type: "SET_INLINE_CONFIRMATION_TOOL_CALL_ID",
        toolCallId: null,
      });
      expect(next.inlineConfirmationToolCallId).toBeNull();
    });
  });

  // ----- Contact request flow -----
  describe("contact request flow", () => {
    it("SHOW_CONTACT_REQUEST sets pendingContactRequest", () => {
      const payload = { requestId: "cr1", channel: "email" };
      const next = interactionReducer(INITIAL_INTERACTION_STATE, {
        type: "SHOW_CONTACT_REQUEST",
        payload,
      });
      expect(next.pendingContactRequest).toEqual(payload);
      expect(next.isSubmittingContactRequest).toBe(false);
      expect(next.contactRequestAccepted).toBe(false);
    });

    it("SUBMIT_CONTACT_REQUEST_START / END toggle flag", () => {
      const state: InteractionState = {
        ...INITIAL_INTERACTION_STATE,
        pendingContactRequest: { requestId: "cr1" },
      };
      const started = interactionReducer(state, {
        type: "SUBMIT_CONTACT_REQUEST_START",
      });
      expect(started.isSubmittingContactRequest).toBe(true);

      const ended = interactionReducer(started, {
        type: "SUBMIT_CONTACT_REQUEST_END",
      });
      expect(ended.isSubmittingContactRequest).toBe(false);
    });

    it("DISMISS_CONTACT_REQUEST clears pendingContactRequest", () => {
      const state: InteractionState = {
        ...INITIAL_INTERACTION_STATE,
        pendingContactRequest: { requestId: "cr1" },
        isSubmittingContactRequest: true,
      };
      const next = interactionReducer(state, {
        type: "DISMISS_CONTACT_REQUEST",
      });
      expect(next.pendingContactRequest).toBeNull();
      expect(next.isSubmittingContactRequest).toBe(false);
    });

    it("ACCEPT_CONTACT_REQUEST sets contactRequestAccepted", () => {
      const state: InteractionState = {
        ...INITIAL_INTERACTION_STATE,
        pendingContactRequest: { requestId: "cr1" },
      };
      const next = interactionReducer(state, {
        type: "ACCEPT_CONTACT_REQUEST",
      });
      expect(next.contactRequestAccepted).toBe(true);
    });
  });

  // ----- Question flow -----
  describe("question flow", () => {
    const questionPayload = {
      requestId: "q1",
      entries: [
        {
          id: "q1",
          question: "Which option?",
          description: "Pick one",
          options: [{ id: "a", label: "A" }],
          freeTextPlaceholder: "Or type your own...",
        },
      ],
      toolUseId: "tu-1",
    };

    it("SHOW_QUESTION sets pendingQuestion and resets submit/dismissed flags", () => {
      const state: InteractionState = {
        ...INITIAL_INTERACTION_STATE,
        isSubmittingQuestion: true,
        isQuestionCardDismissed: true,
      };
      const next = interactionReducer(state, {
        type: "SHOW_QUESTION",
        payload: questionPayload,
      });
      expect(next.pendingQuestion).toEqual(questionPayload);
      expect(next.isSubmittingQuestion).toBe(false);
      expect(next.isQuestionCardDismissed).toBe(false);
    });

    it("SUBMIT_QUESTION_START sets isSubmittingQuestion", () => {
      const state: InteractionState = {
        ...INITIAL_INTERACTION_STATE,
        pendingQuestion: questionPayload,
      };
      const next = interactionReducer(state, { type: "SUBMIT_QUESTION_START" });
      expect(next.isSubmittingQuestion).toBe(true);
    });

    it("SUBMIT_QUESTION_END clears isSubmittingQuestion", () => {
      const state: InteractionState = {
        ...INITIAL_INTERACTION_STATE,
        pendingQuestion: questionPayload,
        isSubmittingQuestion: true,
      };
      const next = interactionReducer(state, { type: "SUBMIT_QUESTION_END" });
      expect(next.isSubmittingQuestion).toBe(false);
    });

    it("DISMISS_QUESTION clears all question state", () => {
      const state: InteractionState = {
        ...INITIAL_INTERACTION_STATE,
        pendingQuestion: questionPayload,
        isSubmittingQuestion: true,
        isQuestionCardDismissed: true,
      };
      const next = interactionReducer(state, { type: "DISMISS_QUESTION" });
      expect(next.pendingQuestion).toBeNull();
      expect(next.isSubmittingQuestion).toBe(false);
      expect(next.isQuestionCardDismissed).toBe(false);
    });

    it("DISMISS_QUESTION_CARD hides card but preserves pendingQuestion", () => {
      const state: InteractionState = {
        ...INITIAL_INTERACTION_STATE,
        pendingQuestion: questionPayload,
      };
      const next = interactionReducer(state, { type: "DISMISS_QUESTION_CARD" });
      expect(next.isQuestionCardDismissed).toBe(true);
      expect(next.pendingQuestion).toEqual(questionPayload);
    });
  });

  // ----- Reset -----
  describe("RESET_ALL", () => {
    it("resets all state to initial values", () => {
      const dirty: InteractionState = {
        pendingSecret: { requestId: "r1" },
        isSubmittingSecret: true,
        secretSaved: true,
        pendingConfirmation: { requestId: "c1" },
        isSubmittingConfirmation: true,
        pendingContactRequest: { requestId: "cr1" },
        isSubmittingContactRequest: true,
        contactRequestAccepted: true,
        pendingQuestion: { requestId: "q1", entries: [{ id: "q1", question: "Pick one", options: [] }] },
        isSubmittingQuestion: true,
        isQuestionCardDismissed: true,
        inlineConfirmationToolCallId: "tc-1",
      };
      const next = interactionReducer(dirty, { type: "RESET_ALL" });
      expect(next).toEqual(INITIAL_INTERACTION_STATE);
    });
  });

  describe("RESET_SECRET_AND_CONFIRMATION", () => {
    it("clears secret and confirmation but preserves contact request and question", () => {
      const dirty: InteractionState = {
        pendingSecret: { requestId: "r1" },
        isSubmittingSecret: true,
        secretSaved: true,
        pendingConfirmation: { requestId: "c1" },
        isSubmittingConfirmation: true,
        pendingContactRequest: { requestId: "cr1" },
        isSubmittingContactRequest: true,
        contactRequestAccepted: true,
        pendingQuestion: { requestId: "q1", entries: [{ id: "q1", question: "Pick one", options: [] }] },
        isSubmittingQuestion: true,
        isQuestionCardDismissed: true,
        inlineConfirmationToolCallId: "tc-1",
      };
      const next = interactionReducer(dirty, {
        type: "RESET_SECRET_AND_CONFIRMATION",
      });
      expect(next.pendingSecret).toBeNull();
      expect(next.isSubmittingSecret).toBe(false);
      expect(next.secretSaved).toBe(false);
      expect(next.pendingConfirmation).toBeNull();
      expect(next.isSubmittingConfirmation).toBe(false);
      expect(next.inlineConfirmationToolCallId).toBeNull();
      expect(next.pendingContactRequest).toEqual({ requestId: "cr1" });
      expect(next.isSubmittingContactRequest).toBe(true);
      expect(next.contactRequestAccepted).toBe(true);
      // Question state is preserved — the daemon is still blocking on
      // /question-response/ and clearing the card would leave the user with
      // no way to answer.  Only explicit DISMISS_QUESTION clears it.
      expect(next.pendingQuestion).toEqual({ requestId: "q1", entries: [{ id: "q1", question: "Pick one", options: [] }] });
      expect(next.isSubmittingQuestion).toBe(true);
      expect(next.isQuestionCardDismissed).toBe(true);
    });
  });

  // ----- hasActiveInteraction -----
  describe("hasActiveInteraction", () => {
    it("returns false for initial state", () => {
      expect(hasActiveInteraction(INITIAL_INTERACTION_STATE)).toBe(false);
    });

    it("returns true when secret is pending", () => {
      const state: InteractionState = {
        ...INITIAL_INTERACTION_STATE,
        pendingSecret: { requestId: "r1" },
      };
      expect(hasActiveInteraction(state)).toBe(true);
    });

    it("returns true when confirmation is pending", () => {
      const state: InteractionState = {
        ...INITIAL_INTERACTION_STATE,
        pendingConfirmation: { requestId: "c1" },
      };
      expect(hasActiveInteraction(state)).toBe(true);
    });

    it("returns true when contact request is pending", () => {
      const state: InteractionState = {
        ...INITIAL_INTERACTION_STATE,
        pendingContactRequest: { requestId: "cr1" },
      };
      expect(hasActiveInteraction(state)).toBe(true);
    });

    it("returns true when question is pending", () => {
      const state: InteractionState = {
        ...INITIAL_INTERACTION_STATE,
        pendingQuestion: { requestId: "q1", entries: [{ id: "q1", question: "Pick one", options: [] }] },
      };
      expect(hasActiveInteraction(state)).toBe(true);
    });
  });

  // ----- Unknown event -----
  it("returns state unchanged for unknown event types", () => {
    const result = interactionReducer(
      INITIAL_INTERACTION_STATE,
      { type: "UNKNOWN" } as never,
    );
    expect(result).toBe(INITIAL_INTERACTION_STATE);
  });
});
