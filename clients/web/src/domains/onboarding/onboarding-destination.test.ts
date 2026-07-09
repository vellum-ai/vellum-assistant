import { describe, expect, test } from "bun:test";

import { onboardingDestinationAfterConsent } from "@/domains/onboarding/onboarding-destination";
import { routes } from "@/utils/routes";

describe("onboardingDestinationAfterConsent", () => {
  test("platform/Vellum-Cloud routes straight to the research flow", () => {
    expect(
      onboardingDestinationAfterConsent({
        isNative: false,
        isLocalHatch: false,
      }),
    ).toBe(routes.onboarding.research);
  });

  test("local hosting routes to hatching first (foreground local hatch → research)", () => {
    expect(
      onboardingDestinationAfterConsent({ isNative: false, isLocalHatch: true }),
    ).toBe(routes.onboarding.hatching);
  });

  test("native keeps the standard hatching path", () => {
    expect(
      onboardingDestinationAfterConsent({ isNative: true, isLocalHatch: false }),
    ).toBe(routes.onboarding.hatching);
  });
});
