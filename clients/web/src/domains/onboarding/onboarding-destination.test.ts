import { describe, expect, test } from "bun:test";

import { onboardingDestinationAfterConsent } from "@/domains/onboarding/onboarding-destination";
import { routes } from "@/utils/routes";

describe("onboardingDestinationAfterConsent", () => {
  test("web routes to the research flow (now the default onboarding)", () => {
    expect(onboardingDestinationAfterConsent({ isNative: false })).toBe(
      routes.onboarding.research,
    );
  });

  test("native keeps the hatching path (research not wired for the native shell)", () => {
    expect(onboardingDestinationAfterConsent({ isNative: true })).toBe(
      routes.onboarding.hatching,
    );
  });
});
