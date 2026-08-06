/**
 * Tests for the takeover's direction-dependent copy table. The strings
 * themselves are the contract here, so they are asserted literally: every other
 * suite reads them through `takeoverCopy`, and this is the one place a wording
 * change has to be made deliberately.
 */
import { describe, expect, test } from "bun:test";

import { takeoverCopy, type TakeoverDirection } from "./takeover-copy";

const DIRECTIONS: TakeoverDirection[] = ["upgrade", "downgrade", "change"];

describe("takeoverCopy", () => {
  test("an upgrade names the upgrade throughout", () => {
    const copy = takeoverCopy("upgrade");
    expect(copy.waitingStatus).toBe("Upgrading your assistant…");
    expect(copy.snagStatus).toBe("We hit a snag upgrading your assistant");
    expect(copy.snagCaption).toBe(
      "Retry in the background and we'll keep working on your upgrade.",
    );
    expect(copy.confirmingStatus).toBe("Confirming your upgrade…");
    expect(copy.confirmTimeoutStatus).toBe("Still confirming your upgrade");
    expect(copy.confirmTimeoutCaption).toBe(
      "Your payment went through safely. This can take a minute.",
    );
    expect(copy.backgroundConfirmMessage).toBe(
      "Your assistant is still upgrading. Chatting won't be available until it finishes. You can keep waiting here, or continue and we'll let you know when it's ready.",
    );
    expect(copy.backgroundExitToast).toBe(
      "Your upgrade continues in the background.",
    );
    expect(copy.backgroundRetryToast).toBe(
      "We'll retry your upgrade in the background.",
    );
    expect(copy.completeSubtitle).toBe("Enjoy the new found power.");
    expect(copy.fetchErrorBody).toBe(
      "We hit a problem checking your subscription. Your upgrade may still be processing. Return to billing to refresh.",
    );
  });

  test("a downgrade states a plan change, never an upgrade", () => {
    const copy = takeoverCopy("downgrade");
    expect(copy.waitingStatus).toBe("Updating your assistant…");
    expect(copy.snagStatus).toBe("We hit a snag updating your assistant");
    expect(copy.snagCaption).toBe(
      "Retry in the background and we'll keep working on your plan change.",
    );
    expect(copy.confirmingStatus).toBe("Confirming your plan change…");
    expect(copy.confirmTimeoutStatus).toBe("Still confirming your plan change");
    // A net package decrease is credited toward the next invoice, so there may
    // have been no payment to reassure anyone about.
    expect(copy.confirmTimeoutCaption).toBe(
      "Your plan change was submitted. This can take a minute.",
    );
    expect(copy.backgroundConfirmMessage).toBe(
      "Your assistant is still updating. Chatting won't be available until it finishes. You can keep waiting here, or continue and we'll let you know when it's ready.",
    );
    expect(copy.backgroundExitToast).toBe(
      "Your plan change continues in the background.",
    );
    expect(copy.backgroundRetryToast).toBe(
      "We'll retry your plan change in the background.",
    );
    expect(copy.completeSubtitle).toBe("Your plan changes are live.");
    expect(copy.fetchErrorBody).toBe(
      "We hit a problem checking your subscription. Your plan change may still be processing. Return to billing to refresh.",
    );
  });

  test("a direction-unknown change reads exactly like a downgrade", () => {
    expect(takeoverCopy("change")).toEqual(takeoverCopy("downgrade"));
  });

  test("an absent direction falls back to the upgrade wording", () => {
    expect(takeoverCopy()).toEqual(takeoverCopy("upgrade"));
    expect(takeoverCopy(undefined)).toEqual(takeoverCopy("upgrade"));
  });

  test("only the upgrade direction says 'upgrade' anywhere", () => {
    for (const direction of DIRECTIONS) {
      const strings = Object.values(takeoverCopy(direction));
      const mentionsUpgrade = strings.some((s) => /upgrad/i.test(s));
      expect(mentionsUpgrade).toBe(direction === "upgrade");
    }
  });

  test("only the upgrade direction claims a payment", () => {
    for (const direction of DIRECTIONS) {
      const strings = Object.values(takeoverCopy(direction));
      const mentionsPayment = strings.some((s) => /payment/i.test(s));
      expect(mentionsPayment).toBe(direction === "upgrade");
    }
  });

  test("no string carries an em dash", () => {
    // Escaped rather than literal: the repo bans the character itself, and the
    // pre-ship diff check greps for it.
    const EM_DASH = "\u2014";
    for (const direction of DIRECTIONS) {
      for (const value of Object.values(takeoverCopy(direction))) {
        expect(value).not.toContain(EM_DASH);
      }
    }
  });
});
