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

  test("exposes the activation flow experiment as an assistant flag (not client)", () => {
    // The activation flag is now scope:'assistant' — the daemon evaluates it, not the web client.
    // The web client gates the rail via the recipe cohort delivered by the platform (JARVIS-1102).
    expect(
      "experimentActivationFlow20260603" in CLIENT_FLAG_DEFAULTS,
    ).toBe(false);
    expect(ASSISTANT_FLAG_DEFAULTS.experimentActivationFlow20260603).toBe(false);
  });
});
