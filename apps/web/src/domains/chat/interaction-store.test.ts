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
      expect(s.isSubmittingSecret).toBe(false);
      expect(s.secretSaved).toBe(false);
    });

    it("submitSecretStart sets isSubmittingSecret", () => {
      useInteractionStore.getState().showSecret({ requestId: "r1" });
      useInteractionStore.getState().submitSecretStart();
      expect(useInteractionStore.getState().isSubmittingSecret).toBe(true);
    });

    it("submitSecretEnd clears isSubmittingSecret and sets saved flag", () => {
      useInteractionStore.getState().showSecret({ requestId: "r1" });
      useInteractionStore.getState().submitSecretStart();
      useInteractionStore.getState().submitSecretEnd(true);
      const s = useInteractionStore.getState();
      expect(s.isSubmittingSecret).toBe(false);
      expect(s.secretSaved).toBe(true);
    });

    it("dismissSecret clears pendingSecret and isSubmittingSecret", () => {
      useInteractionStore.getState().showSecret({ requestId: "r1" });
      useInteractionStore.getState().submitSecretStart();
      useInteractionStore.getState().dismissSecret();
      const s = useInteractionStore.getState();
      expect(s.pendingSecret).toBeNull();
      expect(s.isSubmittingSecret).toBe(false);
    });

    it("updateSecret applies patch when requestId matches", () => {
      useInteractionStore.getState().showSecret({ requestId: "r1", label: "old" });
      useInteractionStore.getState().updateSecret("r1", { label: "new" });
      expect(useInteractionStore.getState().pendingSecret?.label).toBe("new");
    });

    it("updateSecret is a no-op when requestId does not match", () => {
      useInteractionStore.getState().showSecret({ requestId: "r1", label: "old" });
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
      const s = useInteractionStore.getState();
      expect(s.pendingConfirmation).toEqual(payload);
      expect(s.isSubmittingConfirmation).toBe(false);
    });

    it("submitConfirmationStart/End cycle", () => {
      useInteractionStore.getState().showConfirmation({ requestId: "c1" });
      useInteractionStore.getState().submitConfirmationStart();
      expect(useInteractionStore.getState().isSubmittingConfirmation).toBe(true);
      useInteractionStore.getState().submitConfirmationEnd();
      expect(useInteractionStore.getState().isSubmittingConfirmation).toBe(false);
    });

    it("dismissConfirmation clears state", () => {
      useInteractionStore.getState().showConfirmation({ requestId: "c1" });
      useInteractionStore.getState().submitConfirmationStart();
      useInteractionStore.getState().dismissConfirmation();
      const s = useInteractionStore.getState();
      expect(s.pendingConfirmation).toBeNull();
      expect(s.isSubmittingConfirmation).toBe(false);
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
      useInteractionStore.getState().showConfirmation({ requestId: "c1", title: "old" });
      useInteractionStore.getState().updateConfirmation("c1", { title: "new" });
      expect(useInteractionStore.getState().pendingConfirmation?.title).toBe("new");
    });

    it("updateConfirmation is a no-op when requestId does not match", () => {
      useInteractionStore.getState().showConfirmation({ requestId: "c1", title: "old" });
      useInteractionStore.getState().updateConfirmation("c2", { title: "new" });
      expect(useInteractionStore.getState().pendingConfirmation?.title).toBe("old");
    });

    it("setInlineConfirmationToolCallId sets the value", () => {
      useInteractionStore.getState().setInlineConfirmationToolCallId("tc-1");
      expect(useInteractionStore.getState().inlineConfirmationToolCallId).toBe("tc-1");
      useInteractionStore.getState().setInlineConfirmationToolCallId(null);
      expect(useInteractionStore.getState().inlineConfirmationToolCallId).toBeNull();
    });
  });

  // ----- Contact request flow -----
  describe("contact request flow", () => {
    it("showContactRequest sets state and resets flags", () => {
      const payload = { requestId: "cr1", channel: "email" };
      useInteractionStore.getState().showContactRequest(payload);
      const s = useInteractionStore.getState();
      expect(s.pendingContactRequest).toEqual(payload);
      expect(s.isSubmittingContactRequest).toBe(false);
      expect(s.contactRequestAccepted).toBe(false);
    });

    it("submitContactRequestStart/End cycle", () => {
      useInteractionStore.getState().showContactRequest({ requestId: "cr1" });
      useInteractionStore.getState().submitContactRequestStart();
      expect(useInteractionStore.getState().isSubmittingContactRequest).toBe(true);
      useInteractionStore.getState().submitContactRequestEnd();
      expect(useInteractionStore.getState().isSubmittingContactRequest).toBe(false);
    });

    it("dismissContactRequest clears state", () => {
      useInteractionStore.getState().showContactRequest({ requestId: "cr1" });
      useInteractionStore.getState().dismissContactRequest();
      const s = useInteractionStore.getState();
      expect(s.pendingContactRequest).toBeNull();
      expect(s.isSubmittingContactRequest).toBe(false);
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
      expect(s.isSubmittingQuestion).toBe(false);
      expect(s.isQuestionCardDismissed).toBe(false);
    });

    it("submitQuestionStart/End cycle", () => {
      useInteractionStore.getState().showQuestion({ requestId: "q1", entries: [] });
      useInteractionStore.getState().submitQuestionStart();
      expect(useInteractionStore.getState().isSubmittingQuestion).toBe(true);
      useInteractionStore.getState().submitQuestionEnd();
      expect(useInteractionStore.getState().isSubmittingQuestion).toBe(false);
    });

    it("dismissQuestion clears all question state", () => {
      useInteractionStore.getState().showQuestion({ requestId: "q1", entries: [] });
      useInteractionStore.getState().dismissQuestionCard();
      useInteractionStore.getState().dismissQuestion();
      const s = useInteractionStore.getState();
      expect(s.pendingQuestion).toBeNull();
      expect(s.isSubmittingQuestion).toBe(false);
      expect(s.isQuestionCardDismissed).toBe(false);
    });

    it("dismissQuestionCard hides card but keeps pendingQuestion", () => {
      useInteractionStore.getState().showQuestion({ requestId: "q1", entries: [] });
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
      useInteractionStore.getState().showQuestion({ requestId: "q1", entries: [] });
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
      useInteractionStore.getState().showQuestion({ requestId: "q1", entries: [] });

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
