import { describe, expect, test } from "bun:test";

import {
  ASSISTANT_FLAG_DEFAULTS,
  CLIENT_FLAG_DEFAULTS,
} from "@/lib/feature-flags/feature-flag-catalog";

describe("feature flag catalog", () => {
  test("exposes self-intro greeting to client and assistant flag stores", () => {
    expect(CLIENT_FLAG_DEFAULTS.selfIntroGreeting).toBe(false);
    expect(ASSISTANT_FLAG_DEFAULTS.selfIntroGreeting).toBe(false);
  });

  test("does not declare the activation flow experiment as a toggleable flag", () => {
    // The activation rail is gated by the onboarding recipe cohort (control /
    // treatment) assigned vid-keyed on the platform — not by a boolean feature
    // flag. Declaring it in the registry would render it as a manual toggle in
    // Settings → Feature Flags, letting a hand-flipped override diverge from the
    // vid-keyed assignment, so it must not appear in either flag store (JARVIS-1102).
    expect(
      "experimentActivationFlow20260603" in CLIENT_FLAG_DEFAULTS,
    ).toBe(false);
    expect(
      "experimentActivationFlow20260603" in ASSISTANT_FLAG_DEFAULTS,
    ).toBe(false);
  });
});
