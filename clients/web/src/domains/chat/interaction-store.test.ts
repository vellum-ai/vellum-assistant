import { beforeEach, describe, expect, it } from "bun:test";
import {
  reportSubmissionFailure,
  type PromptKind,
} from "@/domains/chat/prompt-submission";
import {
  useInteractionStore,
  hasActiveInteraction,
} from "@/domains/chat/interaction-store";
import { t } from "@/i18n";

import { useChatSessionStore } from "@/domains/chat/chat-session-store";

// Reset store between tests to avoid cross-contamination
beforeEach(() => {
  // `resetAll` is the conversation-switch reset and deliberately carries the
  // workspace-global contact forms across it, so a test needs a blanker slate
  // than that.
  useInteractionStore.setState(useInteractionStore.getInitialState(), true);
});

describe("useInteractionStore", () => {
  // ----- Secret flow -----
  describe("secret flow", () => {
    it("showSecret sets pendingSecret and resets the saved flag", () => {
      const payload = { requestId: "r1", label: "API Key" };
      useInteractionStore.getState().showSecret(payload);
      const s = useInteractionStore.getState();
      expect(s.pendingSecret).toEqual(payload);
      expect(s.submittingByKind.secret).toBeNull();
      expect(s.secretSaved).toBe(false);
    });

    it("showSecret merges sparse rehydrate without erasing rich metadata", () => {
      // Live SSE event arrives first with full metadata.
      useInteractionStore.getState().showSecret({
        requestId: "r1",
        label: "API Key",
        description: "Used to call the service",
        placeholder: "sk-...",
      });
      // Sparse rehydrate fires for the same prompt with only the requestId.
      useInteractionStore.getState().showSecret({ requestId: "r1" });
      const s = useInteractionStore.getState();
      expect(s.pendingSecret).toEqual({
        requestId: "r1",
        label: "API Key",
        description: "Used to call the service",
        placeholder: "sk-...",
      });
    });

    it("showSecret replaces fresh when requestId differs", () => {
      useInteractionStore
        .getState()
        .showSecret({ requestId: "r1", label: "First" });
      useInteractionStore
        .getState()
        .showSecret({ requestId: "r2", label: "Second" });
      const s = useInteractionStore.getState();
      expect(s.pendingSecret).toEqual({ requestId: "r2", label: "Second" });
      expect(s.submittingByKind.secret).toBeNull();
      expect(s.secretSaved).toBe(false);
    });

    it("showSecret same-requestId merge preserves the in-flight submission", () => {
      useInteractionStore
        .getState()
        .showSecret({ requestId: "r1", label: "API Key" });
      useInteractionStore.getState().claimSubmission("secret", "r1");
      useInteractionStore.getState().showSecret({ requestId: "r1" });
      const s = useInteractionStore.getState();
      expect(s.submittingByKind.secret).not.toBeNull();
      expect(s.pendingSecret?.label).toBe("API Key");
    });

    it("submitSecretStart records the request being submitted", () => {
      useInteractionStore.getState().showSecret({ requestId: "r1" });
      useInteractionStore.getState().claimSubmission("secret", "r1");
      expect(
        useInteractionStore.getState().submittingByKind.secret,
      ).not.toBeNull();
    });

    it("releasing the slot does not decide the saved tick", () => {
      // Who holds the slot and whether the secret saved are separate facts, so
      // the outcome is reported rather than inferred from the release.
      useInteractionStore.getState().showSecret({ requestId: "r1" });
      useInteractionStore.getState().claimSubmission("secret", "r1");
      useInteractionStore.getState().releaseSubmission("secret", "r1");
      const s = useInteractionStore.getState();
      expect(s.submittingByKind.secret).toBeNull();
      expect(s.secretSaved).toBe(false);
    });

    it("a failed submission clears a tick an earlier success left", () => {
      // The tick describes the last submission, not the best one. Retrying the
      // same prompt and failing must not keep showing a success.
      useInteractionStore.getState().showSecret({ requestId: "r1" });
      useInteractionStore.getState().setSecretSavedIfMatches("r1", true);
      useInteractionStore.getState().setSecretSavedIfMatches("r1", false);
      expect(useInteractionStore.getState().secretSaved).toBe(false);
    });

    it("a superseded request cannot write the tick", () => {
      // The tick belongs to the card on screen. A request the user can no
      // longer see must not erase the outcome of the one they can.
      useInteractionStore.getState().showSecret({ requestId: "r1" });
      useInteractionStore.getState().showSecret({ requestId: "r2" });
      useInteractionStore.getState().setSecretSavedIfMatches("r2", true);

      useInteractionStore.getState().setSecretSavedIfMatches("r1", false);

      expect(useInteractionStore.getState().secretSaved).toBe(true);
    });

    it("dismissSecretIfMatches retires the prompt it names", () => {
      useInteractionStore.getState().showSecret({ requestId: "r1" });
      useInteractionStore.getState().dismissSecretIfMatches("r1");
      expect(useInteractionStore.getState().pendingSecret).toBeNull();
    });

    it("dismissSecretIfMatches leaves a prompt it does not name", () => {
      useInteractionStore.getState().showSecret({ requestId: "r1" });
      useInteractionStore.getState().dismissSecretIfMatches("r2");
      expect(useInteractionStore.getState().pendingSecret?.requestId).toBe(
        "r1",
      );
    });

    it("updateSecret applies patch when requestId matches", () => {
      useInteractionStore
        .getState()
        .showSecret({ requestId: "r1", label: "old" });
      useInteractionStore.getState().updateSecret("r1", { label: "new" });
      expect(useInteractionStore.getState().pendingSecret?.label).toBe("new");
    });

    it("updateSecret is a no-op when requestId does not match", () => {
      useInteractionStore
        .getState()
        .showSecret({ requestId: "r1", label: "old" });
      useInteractionStore.getState().updateSecret("r2", { label: "new" });
      expect(useInteractionStore.getState().pendingSecret?.label).toBe("old");
    });

    it("updateSecret is a no-op when pendingSecret is null", () => {
      useInteractionStore.getState().updateSecret("r1", { label: "new" });
      expect(useInteractionStore.getState().pendingSecret).toBeNull();
    });
  });

  // ----- Confirmation flow -----
  describe("confirmation flow", () => {
    it("showConfirmation sets pendingConfirmation", () => {
      const payload = { requestId: "c1", title: "Deploy?" };
      useInteractionStore.getState().showConfirmation(payload);
      expect(useInteractionStore.getState().pendingConfirmation).toEqual(
        payload,
      );
    });

    it("submitConfirmationStart/End cycle", () => {
      useInteractionStore.getState().claimSubmission("confirmation", "c1");
      expect(useInteractionStore.getState().submittingByKind.confirmation).toBe(
        "c1",
      );
      useInteractionStore.getState().releaseSubmission("confirmation", "c1");
      expect(
        useInteractionStore.getState().submittingByKind.confirmation,
      ).toBeNull();
    });

    it("submitConfirmationEnd ignores a request that does not hold the slot", () => {
      useInteractionStore.getState().claimSubmission("confirmation", "c1");
      useInteractionStore
        .getState()
        .releaseSubmission("confirmation", "c-other");
      // A superseded response cannot reopen the double-submit guard for the
      // submission that holds it now.
      expect(useInteractionStore.getState().submittingByKind.confirmation).toBe(
        "c1",
      );
    });

    it("the card's lifecycle leaves an in-flight submission alone", () => {
      useInteractionStore.getState().showConfirmation({ requestId: "c1" });
      useInteractionStore.getState().claimSubmission("confirmation", "c1");

      // The daemon broadcasts `interaction_resolved` before its POST response
      // returns, so the card is routinely retired while its own submission is
      // still on the wire. Retiring the card says nothing about that.
      useInteractionStore.getState().dismissConfirmationIfMatches("c1");
      expect(useInteractionStore.getState().pendingConfirmation).toBeNull();
      expect(useInteractionStore.getState().submittingByKind.confirmation).toBe(
        "c1",
      );

      // Nor does a different prompt arriving.
      useInteractionStore.getState().showConfirmation({ requestId: "c2" });
      expect(useInteractionStore.getState().submittingByKind.confirmation).toBe(
        "c1",
      );

      useInteractionStore.getState().dismissConfirmationIfMatches("c2");
      expect(useInteractionStore.getState().submittingByKind.confirmation).toBe(
        "c1",
      );
    });

    it("dismissConfirmationIfMatches clears when requestId matches", () => {
      useInteractionStore.getState().showConfirmation({ requestId: "c1" });
      useInteractionStore.getState().dismissConfirmationIfMatches("c1");
      expect(useInteractionStore.getState().pendingConfirmation).toBeNull();
    });

    it("dismissConfirmationIfMatches is a no-op when requestId does not match", () => {
      useInteractionStore.getState().showConfirmation({ requestId: "c1" });
      useInteractionStore.getState().dismissConfirmationIfMatches("c2");
      expect(useInteractionStore.getState().pendingConfirmation).not.toBeNull();
    });

    it("updateConfirmation applies patch when requestId matches", () => {
      useInteractionStore
        .getState()
        .showConfirmation({ requestId: "c1", title: "old" });
      useInteractionStore.getState().updateConfirmation("c1", { title: "new" });
      expect(useInteractionStore.getState().pendingConfirmation?.title).toBe(
        "new",
      );
    });

    it("updateConfirmation is a no-op when requestId does not match", () => {
      useInteractionStore
        .getState()
        .showConfirmation({ requestId: "c1", title: "old" });
      useInteractionStore.getState().updateConfirmation("c2", { title: "new" });
      expect(useInteractionStore.getState().pendingConfirmation?.title).toBe(
        "old",
      );
    });

    it("setInlineConfirmationToolCallId sets the value", () => {
      useInteractionStore.getState().setInlineConfirmationToolCallId("tc-1");
      expect(useInteractionStore.getState().inlineConfirmationToolCallId).toBe(
        "tc-1",
      );
      useInteractionStore.getState().setInlineConfirmationToolCallId(null);
      expect(
        useInteractionStore.getState().inlineConfirmationToolCallId,
      ).toBeNull();
    });
  });

  // ----- Contact request flow -----
  describe("contact request flow", () => {
    it("showContactRequest sets state and resets flags", () => {
      const payload = { requestId: "cr1", channel: "email" };
      useInteractionStore.getState().showContactRequest(payload);
      const s = useInteractionStore.getState();
      expect(s.pendingContactRequest).toEqual(payload);
      expect(s.submittingByKind.contactRequest).toBeNull();
      expect(s.contactRequestAccepted).toBe(false);
    });

    it("submitContactRequestStart/End cycle", () => {
      useInteractionStore.getState().showContactRequest({ requestId: "cr1" });
      useInteractionStore.getState().claimSubmission("contactRequest", "cr1");
      expect(
        useInteractionStore.getState().submittingByKind.contactRequest,
      ).not.toBeNull();
      useInteractionStore.getState().releaseSubmission("contactRequest", "cr1");
      expect(
        useInteractionStore.getState().submittingByKind.contactRequest,
      ).toBeNull();
    });

    it("dismissContactRequestIfMatches retires the prompt it names", () => {
      useInteractionStore.getState().showContactRequest({ requestId: "cr1" });
      useInteractionStore.getState().dismissContactRequestIfMatches("cr1");
      expect(useInteractionStore.getState().pendingContactRequest).toBeNull();
    });

    it("dismissContactRequestIfMatches leaves a prompt it does not name", () => {
      useInteractionStore.getState().showContactRequest({ requestId: "cr1" });
      useInteractionStore.getState().dismissContactRequestIfMatches("cr2");
      expect(
        useInteractionStore.getState().pendingContactRequest?.requestId,
      ).toBe("cr1");
    });

    it("acceptContactRequestIfMatches sets flag for the card on screen", () => {
      useInteractionStore.getState().showContactRequest({ requestId: "cr1" });
      useInteractionStore.getState().acceptContactRequestIfMatches("cr1");
      expect(useInteractionStore.getState().contactRequestAccepted).toBe(true);
    });

    it("acceptContactRequestIfMatches ignores a response for a card that is gone", () => {
      useInteractionStore.getState().showContactRequest({ requestId: "cr2" });

      // A response can land after its own card was replaced, and the card that
      // replaced it belongs to someone else's request.
      useInteractionStore.getState().acceptContactRequestIfMatches("cr1");

      expect(useInteractionStore.getState().contactRequestAccepted).toBe(false);
    });
  });

  // ----- Question flow -----
  describe("question flow", () => {
    it("showQuestion sets state and resets flags", () => {
      const payload = { requestId: "q1", entries: [] };
      useInteractionStore.getState().showQuestion(payload);
      const s = useInteractionStore.getState();
      expect(s.pendingQuestion).toEqual(payload);
      expect(s.isQuestionCardDismissed).toBe(false);
    });

    it("submitQuestionStart/End cycle", () => {
      useInteractionStore.getState().claimSubmission("question", "q1");
      expect(useInteractionStore.getState().submittingByKind.question).toBe(
        "q1",
      );
      useInteractionStore.getState().releaseSubmission("question", "q1");
      expect(
        useInteractionStore.getState().submittingByKind.question,
      ).toBeNull();
    });

    it("retiring a question card leaves an in-flight submission alone", () => {
      useInteractionStore
        .getState()
        .showQuestion({ requestId: "q1", entries: [] });
      useInteractionStore.getState().claimSubmission("question", "q1");
      useInteractionStore.getState().dismissQuestionIfMatches("q1");
      expect(useInteractionStore.getState().pendingQuestion).toBeNull();
      expect(useInteractionStore.getState().submittingByKind.question).toBe(
        "q1",
      );
    });

    it("retiring a card also clears the hidden-card flag", () => {
      useInteractionStore
        .getState()
        .showQuestion({ requestId: "q1", entries: [] });
      useInteractionStore.getState().dismissQuestionCard();
      useInteractionStore.getState().dismissQuestionIfMatches("q1");
      const s = useInteractionStore.getState();
      expect(s.pendingQuestion).toBeNull();
      expect(s.isQuestionCardDismissed).toBe(false);
    });

    it("dismissQuestionIfMatches retires the card the answer belongs to", () => {
      useInteractionStore
        .getState()
        .showQuestion({ requestId: "q1", entries: [] });
      useInteractionStore.getState().dismissQuestionIfMatches("q1");
      expect(useInteractionStore.getState().pendingQuestion).toBeNull();
    });

    it("dismissQuestionIfMatches leaves a newer card standing", () => {
      // An answer for a superseded prompt must not close the card the user is
      // currently looking at.
      useInteractionStore
        .getState()
        .showQuestion({ requestId: "q2", entries: [] });
      useInteractionStore.getState().dismissQuestionIfMatches("q1");
      expect(useInteractionStore.getState().pendingQuestion?.requestId).toBe(
        "q2",
      );
    });

    it("dismissQuestionCard hides card but keeps pendingQuestion", () => {
      useInteractionStore
        .getState()
        .showQuestion({ requestId: "q1", entries: [] });
      useInteractionStore.getState().dismissQuestionCard();
      const s = useInteractionStore.getState();
      expect(s.pendingQuestion).not.toBeNull();
      expect(s.isQuestionCardDismissed).toBe(true);
    });
  });

  // ----- Reset flows -----
  describe("reset flows", () => {
    it("resetSecretAndConfirmation clears secret+confirmation but preserves question", () => {
      useInteractionStore.getState().showSecret({ requestId: "r1" });
      useInteractionStore.getState().showConfirmation({ requestId: "c1" });
      useInteractionStore
        .getState()
        .showQuestion({ requestId: "q1", entries: [] });
      useInteractionStore.getState().setInlineConfirmationToolCallId("tc-1");

      useInteractionStore.getState().resetSecretAndConfirmation();
      const s = useInteractionStore.getState();
      expect(s.pendingSecret).toBeNull();
      expect(s.pendingConfirmation).toBeNull();
      expect(s.inlineConfirmationToolCallId).toBeNull();
      expect(s.pendingQuestion).not.toBeNull();
    });

    it("resetAll clears the per-conversation prompts", () => {
      useInteractionStore.getState().showSecret({ requestId: "r1" });
      useInteractionStore.getState().showConfirmation({ requestId: "c1" });
      useInteractionStore
        .getState()
        .showQuestion({ requestId: "q1", entries: [] });

      useInteractionStore.getState().resetAll();
      const s = useInteractionStore.getState();
      expect(s.pendingSecret).toBeNull();
      expect(s.pendingConfirmation).toBeNull();
      expect(s.pendingQuestion).toBeNull();
    });
  });

  // ----- hasActiveInteraction -----
  describe("hasActiveInteraction", () => {
    it("returns false for initial state", () => {
      expect(hasActiveInteraction(useInteractionStore.getState())).toBe(false);
    });

    it("returns true when any prompt is pending", () => {
      useInteractionStore.getState().showSecret({ requestId: "r1" });
      expect(hasActiveInteraction(useInteractionStore.getState())).toBe(true);
    });
  });
});

describe("prompt slots: the shared invariant", () => {
  /**
   * Which prompt is on screen and which request is on the wire are independent.
   * Conflating them is what let a resume mistake its own resolution for a
   * stranger's, and the kinds are similar enough that a new one can pick up
   * half the pattern unnoticed. Driven off `PromptKind` itself, so a fifth is
   * covered the moment it exists rather than when someone remembers to add it.
   */
  const KINDS: PromptKind[] = [
    "confirmation",
    "question",
    "secret",
    "contactRequest",
    "contactRecordRequest",
  ];

  /**
   * Only the prompt half still needs naming per kind. The submission half is
   * uniform, which is the point: it is the half that carries ownership.
   */
  const RAISE: Record<PromptKind, (requestId: string) => void> = {
    confirmation: (requestId) =>
      useInteractionStore.getState().showConfirmation({ requestId }),
    question: (requestId) =>
      useInteractionStore.getState().showQuestion({ requestId, entries: [] }),
    secret: (requestId) =>
      useInteractionStore.getState().showSecret({ requestId }),
    contactRequest: (requestId) =>
      useInteractionStore.getState().showContactRequest({ requestId }),
    contactRecordRequest: (requestId) =>
      useInteractionStore
        .getState()
        .showContactRecordRequest({ requestId, operation: "create" }),
  };
  const RETIRE: Record<PromptKind, (requestId: string) => void> = {
    confirmation: (requestId) =>
      useInteractionStore.getState().dismissConfirmationIfMatches(requestId),
    question: (requestId) =>
      useInteractionStore.getState().dismissQuestionIfMatches(requestId),
    secret: (requestId) =>
      useInteractionStore.getState().dismissSecretIfMatches(requestId),
    contactRequest: (requestId) =>
      useInteractionStore.getState().dismissContactRequestIfMatches(requestId),
    contactRecordRequest: (requestId) =>
      useInteractionStore
        .getState()
        .dismissContactRecordRequestIfMatches(requestId),
  };

  describe("global contact forms across a conversation switch", () => {
    it("survives resetAll, because the daemon is still holding a command open", () => {
      useInteractionStore.getState().showContactRecordRequest({
        requestId: "r-global",
        operation: "create",
      });
      useInteractionStore
        .getState()
        .showContactRequest({ requestId: "r-address" });
      useInteractionStore
        .getState()
        .claimSubmission("contactRecordRequest", "r-global");

      useInteractionStore.getState().resetAll();

      // Both forms are broadcast without a conversation, so a conversation
      // switch is not news about them. Dropping them would strip the only copy
      // of a form nothing can re-raise.
      expect(
        useInteractionStore.getState().pendingContactRecordRequest?.requestId,
      ).toBe("r-global");
      expect(
        useInteractionStore.getState().pendingContactRequest?.requestId,
      ).toBe("r-address");
      expect(
        useInteractionStore.getState().submittingByKind.contactRecordRequest,
      ).toBe("r-global");
    });

    it("still clears per-conversation prompts", () => {
      useInteractionStore.getState().showConfirmation({ requestId: "r-conf" });
      useInteractionStore.getState().resetAll();
      expect(useInteractionStore.getState().pendingConfirmation).toBeNull();
    });

    it("drops them on an assistant switch, where the form does not belong", () => {
      useInteractionStore.getState().showContactRecordRequest({
        requestId: "r-global",
        operation: "create",
      });
      useInteractionStore
        .getState()
        .showContactRequest({ requestId: "r-address" });

      useInteractionStore.getState().resetAll({ assistantChanged: true });

      // The form was raised by the other assistant's daemon; answering it
      // against this one would post to a gateway that never heard of it.
      expect(
        useInteractionStore.getState().pendingContactRecordRequest,
      ).toBeNull();
      expect(useInteractionStore.getState().pendingContactRequest).toBeNull();
    });
  });

  for (const kind of KINDS) {
    describe(kind, () => {
      it("raising or retiring a prompt leaves the in-flight request alone", () => {
        RAISE[kind]("r1");
        useInteractionStore.getState().claimSubmission(kind, "r1");

        // The matching resolution retires the card while its own submission is
        // still on the wire, which is the ordinary ordering.
        RETIRE[kind]("r1");
        expect(useInteractionStore.getState().submittingByKind[kind]).toBe(
          "r1",
        );

        // A different prompt arriving says nothing about it either.
        RAISE[kind]("r2");
        expect(useInteractionStore.getState().submittingByKind[kind]).toBe(
          "r1",
        );
      });

      it("a failure is reported only by the holder, and only for its own prompt", () => {
        // Which copy lands is not what this covers: every assertion below is
        // about whether the banner is written at all, so any key serves.
        const KEY = "surfaceActions.submitFailed" as const;
        const COPY = t(KEY, { ns: "chat" });
        const banner = () => useChatSessionStore.getState().error?.message;
        const report = (id: string) => reportSubmissionFailure(kind, id, KEY);

        RAISE[kind]("r1");
        useInteractionStore.getState().claimSubmission(kind, "r1");
        report("r1");
        expect(banner()).toBe(COPY);

        // Replaced on screen: the message would explain itself over a prompt
        // the user has not answered.
        useChatSessionStore.getState().setError(null);
        RAISE[kind]("r2");
        report("r1");
        expect(banner()).toBeUndefined();

        // Its own resolution retired the card while it was still awaiting,
        // which is the ordinary shape and leaves nothing to be mistaken for.
        RETIRE[kind]("r2");
        report("r1");
        expect(banner()).toBe(COPY);

        // The slot gone means the interaction was abandoned, and an error about
        // something the user walked away from is noise.
        useChatSessionStore.getState().setError(null);
        useInteractionStore.getState().releaseSubmission(kind, "r1");
        report("r1");
        expect(banner()).toBeUndefined();
      });

      it("only the holder can release the slot", () => {
        useInteractionStore.getState().claimSubmission(kind, "r1");
        useInteractionStore.getState().releaseSubmission(kind, "r2");
        expect(useInteractionStore.getState().submittingByKind[kind]).toBe(
          "r1",
        );
        useInteractionStore.getState().releaseSubmission(kind, "r1");
        expect(
          useInteractionStore.getState().submittingByKind[kind],
        ).toBeNull();
      });

      it("claiming one kind leaves the others alone", () => {
        useInteractionStore.getState().claimSubmission(kind, "r1");
        for (const other of KINDS.filter((k) => k !== kind)) {
          expect(
            useInteractionStore.getState().submittingByKind[other],
          ).toBeNull();
        }
      });
    });
  }
});
