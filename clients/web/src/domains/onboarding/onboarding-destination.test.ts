import { describe, expect, test } from "bun:test";

import { onboardingDestinationAfterConsent } from "@/domains/onboarding/onboarding-destination";
import { routes } from "@/utils/routes";

describe("onboardingDestinationAfterConsent", () => {
  test("flag enabled on web routes to the research flow", () => {
    expect(
      onboardingDestinationAfterConsent({
        researchOnboardingEnabled: true,
        isNative: false,
      }),
    ).toBe(routes.onboarding.research);
  });

  test("flag enabled on native keeps the hatching path (web-only guard)", () => {
    expect(
      onboardingDestinationAfterConsent({
        researchOnboardingEnabled: true,
        isNative: true,
      }),
    ).toBe(routes.onboarding.hatching);
  });

  test("flag disabled on web keeps the hatching path", () => {
    expect(
      onboardingDestinationAfterConsent({
        researchOnboardingEnabled: false,
        isNative: false,
      }),
    ).toBe(routes.onboarding.hatching);
  });
});
