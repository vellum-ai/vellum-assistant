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

  test("exposes the activation flow experiment as a client flag", () => {
    expect(CLIENT_FLAG_DEFAULTS.experimentActivationFlow20260603).toBe(false);
    expect("experimentActivationFlow20260603" in ASSISTANT_FLAG_DEFAULTS).toBe(
      false
    );
  });

  test("does not expose GA empty-state greetings as a feature flag", () => {
    expect("emptyStateDynamicGreetings" in ASSISTANT_FLAG_DEFAULTS).toBe(false);
    expect("emptyStateDynamicGreetings" in CLIENT_FLAG_DEFAULTS).toBe(false);
  });
});
