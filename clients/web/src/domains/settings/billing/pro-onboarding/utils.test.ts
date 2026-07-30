import { describe, expect, test } from "bun:test";

import { extractOnboardingErrorMessage } from "./utils";

const FALLBACK = "fallback caption";

describe("extractOnboardingErrorMessage", () => {
  test("maps a known code to its stock message", () => {
    expect(
      extractOnboardingErrorMessage({ error: "subdomain_taken" }, FALLBACK),
    ).toBe("That subdomain is already taken. Try another.");
  });

  test("an upgrade keeps the upgrade wording", () => {
    expect(
      extractOnboardingErrorMessage(
        { error: "provisioning_submission_failed" },
        FALLBACK,
        "upgrade",
      ),
    ).toBe("We couldn't queue your upgrade just now. Try again in a moment.");
  });

  test("an omitted direction reads as an upgrade", () => {
    expect(
      extractOnboardingErrorMessage(
        { error: "provisioning_submission_failed" },
        FALLBACK,
      ),
    ).toBe("We couldn't queue your upgrade just now. Try again in a moment.");
  });

  test("a downgrade never claims an upgrade", () => {
    // The reconcile these codes come from runs the same way for a downgrade, so
    // a stalled downgrade can surface them from the retry.
    for (const code of [
      "provisioning_submission_failed",
      "no_provisionable_assistants",
    ]) {
      const message = extractOnboardingErrorMessage(
        { error: code },
        FALLBACK,
        "downgrade",
      );
      expect(message).not.toContain("upgrade");
      expect(message).not.toBe(FALLBACK);
    }
  });

  test("a direction-unknown change reads the same as a downgrade", () => {
    expect(
      extractOnboardingErrorMessage(
        { error: "no_provisionable_assistants" },
        FALLBACK,
        "change",
      ),
    ).toBe(
      extractOnboardingErrorMessage(
        { error: "no_provisionable_assistants" },
        FALLBACK,
        "downgrade",
      ),
    );
  });

  test("a code with no direction variant keeps one message either way", () => {
    expect(
      extractOnboardingErrorMessage(
        { error: "no_active_pro" },
        FALLBACK,
        "downgrade",
      ),
    ).toBe("We couldn't confirm your Pro plan yet. Try again in a moment.");
  });

  test("falls back when the error carries no usable message", () => {
    expect(extractOnboardingErrorMessage({}, FALLBACK, "downgrade")).toBe(
      FALLBACK,
    );
    expect(extractOnboardingErrorMessage(null, FALLBACK)).toBe(FALLBACK);
  });
});
