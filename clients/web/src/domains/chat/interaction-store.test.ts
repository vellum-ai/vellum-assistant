import { beforeEach, describe, expect, it } from "bun:test";
import {
  useInteractionStore,
  hasActiveInteraction,
} from "@/domains/chat/interaction-store";

// Reset store between tests to avoid cross-contamination
beforeEach(() => {
  useInteractionStore.getState().resetAll();
});

describe("useInteractionStore", () => {
  // ----- Secret flow -----
  describe("secret flow", () => {
    it("showSecret sets pendingSecret and resets submit/saved flags", () => {
      const payload = { requestId: "r1", label: "API Key" };
      useInteractionStore.getState().showSecret(payload);
      const s = useInteractionStore.getState();
      expect(s.pendingSecret).toEqual(payload);
      expect(s.submittingSecretRequestId).toBeNull();
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
      expect(s.submittingSecretRequestId).toBeNull();
      expect(s.secretSaved).toBe(false);
    });

    it("showSecret same-requestId merge preserves submit/saved flags", () => {
      useInteractionStore
        .getState()
        .showSecret({ requestId: "r1", label: "API Key" });
      useInteractionStore.getState().submitSecretStart("s1");
      useInteractionStore.getState().showSecret({ requestId: "r1" });
      const s = useInteractionStore.getState();
      expect(s.submittingSecretRequestId).not.toBeNull();
      expect(s.pendingSecret?.label).toBe("API Key");
    });

    it("submitSecretStart sets isSubmittingSecret", () => {
      useInteractionStore.getState().showSecret({ requestId: "r1" });
      useInteractionStore.getState().submitSecretStart("s1");
      expect(
        useInteractionStore.getState().submittingSecretRequestId,
      ).not.toBeNull();
    });

    it("submitSecretEnd clears isSubmittingSecret and sets saved flag", () => {
      useInteractionStore.getState().showSecret({ requestId: "r1" });
      useInteractionStore.getState().submitSecretStart("s1");
      useInteractionStore.getState().submitSecretEnd("s1", true);
      const s = useInteractionStore.getState();
      expect(s.submittingSecretRequestId).toBeNull();
      expect(s.secretSaved).toBe(true);
    });

    it("dismissSecret clears pendingSecret and isSubmittingSecret", () => {
      useInteractionStore.getState().showSecret({ requestId: "r1" });
      useInteractionStore.getState().submitSecretStart("s1");
      useInteractionStore.getState().dismissSecretIfMatches("s1");
      const s = useInteractionStore.getState();
      expect(s.pendingSecret).toBeNull();
      expect(s.submittingSecretRequestId).toBeNull();
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
      useInteractionStore.getState().submitConfirmationStart("c1");
      expect(
        useInteractionStore.getState().submittingConfirmationRequestId,
      ).toBe("c1");
      useInteractionStore.getState().submitConfirmationEnd("c1");
      expect(
        useInteractionStore.getState().submittingConfirmationRequestId,
      ).toBeNull();
    });

    it("submitConfirmationEnd ignores a request that does not hold the slot", () => {
      useInteractionStore.getState().submitConfirmationStart("c1");
      useInteractionStore.getState().submitConfirmationEnd("c-other");
      // A superseded response cannot reopen the double-submit guard for the
      // submission that holds it now.
      expect(
        useInteractionStore.getState().submittingConfirmationRequestId,
      ).toBe("c1");
    });

    it("the card's lifecycle leaves an in-flight submission alone", () => {
      useInteractionStore.getState().showConfirmation({ requestId: "c1" });
      useInteractionStore.getState().submitConfirmationStart("c1");

      // The daemon broadcasts `interaction_resolved` before its POST response
      // returns, so the card is routinely retired while its own submission is
      // still on the wire. Retiring the card says nothing about that.
      useInteractionStore.getState().dismissConfirmationIfMatches("c1");
      expect(useInteractionStore.getState().pendingConfirmation).toBeNull();
      expect(
        useInteractionStore.getState().submittingConfirmationRequestId,
      ).toBe("c1");

      // Nor does a different prompt arriving.
      useInteractionStore.getState().showConfirmation({ requestId: "c2" });
      expect(
        useInteractionStore.getState().submittingConfirmationRequestId,
      ).toBe("c1");

      useInteractionStore.getState().dismissConfirmationIfMatches("c2");
      expect(
        useInteractionStore.getState().submittingConfirmationRequestId,
      ).toBe("c1");
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
      expect(s.submittingContactRequestRequestId).toBeNull();
      expect(s.contactRequestAccepted).toBe(false);
    });

    it("submitContactRequestStart/End cycle", () => {
      useInteractionStore.getState().showContactRequest({ requestId: "cr1" });
      useInteractionStore.getState().submitContactRequestStart("ct1");
      expect(
        useInteractionStore.getState().submittingContactRequestRequestId,
      ).not.toBeNull();
      useInteractionStore.getState().submitContactRequestEnd("ct1");
      expect(
        useInteractionStore.getState().submittingContactRequestRequestId,
      ).toBeNull();
    });

    it("dismissContactRequest clears state", () => {
      useInteractionStore.getState().showContactRequest({ requestId: "cr1" });
      useInteractionStore.getState().dismissContactRequestIfMatches("ct1");
      const s = useInteractionStore.getState();
      expect(s.pendingContactRequest).toBeNull();
      expect(s.submittingContactRequestRequestId).toBeNull();
    });

    it("acceptContactRequest sets flag", () => {
      useInteractionStore.getState().showContactRequest({ requestId: "cr1" });
      useInteractionStore.getState().acceptContactRequest();
      expect(useInteractionStore.getState().contactRequestAccepted).toBe(true);
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
      useInteractionStore.getState().submitQuestionStart("q1");
      expect(useInteractionStore.getState().submittingQuestionRequestId).toBe(
        "q1",
      );
      useInteractionStore.getState().submitQuestionEnd("q1");
      expect(
        useInteractionStore.getState().submittingQuestionRequestId,
      ).toBeNull();
    });

    it("retiring a question card leaves an in-flight submission alone", () => {
      useInteractionStore
        .getState()
        .showQuestion({ requestId: "q1", entries: [] });
      useInteractionStore.getState().submitQuestionStart("q1");
      useInteractionStore.getState().dismissQuestionIfMatches("q1");
      expect(useInteractionStore.getState().pendingQuestion).toBeNull();
      expect(useInteractionStore.getState().submittingQuestionRequestId).toBe(
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

    it("resetAll returns to initial state", () => {
      useInteractionStore.getState().showSecret({ requestId: "r1" });
      useInteractionStore.getState().showConfirmation({ requestId: "c1" });
      useInteractionStore.getState().showContactRequest({ requestId: "cr1" });
      useInteractionStore
        .getState()
        .showQuestion({ requestId: "q1", entries: [] });

      useInteractionStore.getState().resetAll();
      const s = useInteractionStore.getState();
      expect(s.pendingSecret).toBeNull();
      expect(s.pendingConfirmation).toBeNull();
      expect(s.pendingContactRequest).toBeNull();
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
   * Every prompt kind keeps two independent things: which prompt is on screen,
   * and which request is on the wire. Conflating them is what let a resume mistake
   * its own resolution for a stranger's, and the shapes are similar enough that a
   * new kind can pick up half the pattern without anyone noticing. Asserted for
   * all four rather than per kind, so a fifth has to opt in here too.
   */
  const KINDS = [
    {
      name: "confirmation",
      show: () =>
        useInteractionStore.getState().showConfirmation({ requestId: "r1" }),
      showOther: () =>
        useInteractionStore.getState().showConfirmation({ requestId: "r2" }),
      retire: (id: string) =>
        useInteractionStore.getState().dismissConfirmationIfMatches(id),
      start: (id: string) =>
        useInteractionStore.getState().submitConfirmationStart(id),
      end: (id: string) =>
        useInteractionStore.getState().submitConfirmationEnd(id),
      holder: () =>
        useInteractionStore.getState().submittingConfirmationRequestId,
    },
    {
      name: "question",
      show: () =>
        useInteractionStore
          .getState()
          .showQuestion({ requestId: "r1", entries: [] }),
      showOther: () =>
        useInteractionStore
          .getState()
          .showQuestion({ requestId: "r2", entries: [] }),
      retire: (id: string) =>
        useInteractionStore.getState().dismissQuestionIfMatches(id),
      start: (id: string) =>
        useInteractionStore.getState().submitQuestionStart(id),
      end: (id: string) => useInteractionStore.getState().submitQuestionEnd(id),
      holder: () => useInteractionStore.getState().submittingQuestionRequestId,
    },
    {
      name: "secret",
      show: () =>
        useInteractionStore.getState().showSecret({ requestId: "r1" }),
      showOther: () =>
        useInteractionStore.getState().showSecret({ requestId: "r2" }),
      retire: (id: string) =>
        useInteractionStore.getState().dismissSecretIfMatches(id),
      start: (id: string) =>
        useInteractionStore.getState().submitSecretStart(id),
      end: (id: string) => useInteractionStore.getState().submitSecretEnd(id),
      holder: () => useInteractionStore.getState().submittingSecretRequestId,
    },
    {
      name: "contact request",
      show: () =>
        useInteractionStore.getState().showContactRequest({ requestId: "r1" }),
      showOther: () =>
        useInteractionStore.getState().showContactRequest({ requestId: "r2" }),
      retire: (id: string) =>
        useInteractionStore.getState().dismissContactRequestIfMatches(id),
      start: (id: string) =>
        useInteractionStore.getState().submitContactRequestStart(id),
      end: (id: string) =>
        useInteractionStore.getState().submitContactRequestEnd(id),
      holder: () =>
        useInteractionStore.getState().submittingContactRequestRequestId,
    },
  ];

  for (const kind of KINDS) {
    describe(kind.name, () => {
      it("raising or retiring a prompt leaves the in-flight request alone", () => {
        kind.show();
        kind.start("r1");

        // The matching resolution retires the card while its own submission is
        // still on the wire, which is the ordinary ordering.
        kind.retire("r1");
        expect(kind.holder()).toBe("r1");

        // A different prompt arriving says nothing about it either.
        kind.showOther();
        expect(kind.holder()).toBe("r1");
      });

      it("only the holder can release the slot", () => {
        kind.start("r1");
        kind.end("r2");
        expect(kind.holder()).toBe("r1");
        kind.end("r1");
        expect(kind.holder()).toBeNull();
      });
    });
  }
});
