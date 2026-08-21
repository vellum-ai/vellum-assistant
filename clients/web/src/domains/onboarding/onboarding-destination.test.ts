import { describe, expect, test } from "bun:test";

import {
  SKIP_RESEARCH_PARAM,
  canSkipOnboardingResearch,
  onboardingDestinationAfterConsent,
  shouldSkipResearchAfterHatch,
  withSkipResearch,
} from "@/domains/onboarding/onboarding-destination";
import { routes } from "@/utils/routes";

describe("canSkipOnboardingResearch", () => {
  test("allows skip on local, dev, staging, and unset", () => {
    expect(canSkipOnboardingResearch(undefined)).toBe(true);
    expect(canSkipOnboardingResearch("local")).toBe(true);
    expect(canSkipOnboardingResearch("dev")).toBe(true);
    expect(canSkipOnboardingResearch("staging")).toBe(true);
  });

  test("blocks skip on production", () => {
    expect(canSkipOnboardingResearch("production")).toBe(false);
  });
});

describe("onboardingDestinationAfterConsent", () => {
  test("platform/Vellum-Cloud routes straight to the research flow", () => {
    expect(
      onboardingDestinationAfterConsent({
        isLocalHatch: false,
      }),
    ).toBe(routes.onboarding.research);
  });

  test("local hosting routes to hatching first (foreground local hatch → research)", () => {
    expect(
      onboardingDestinationAfterConsent({ isLocalHatch: true }),
    ).toBe(routes.onboarding.hatching);
  });

  test("skip-to-chat routes platform onboarding to hatching so the assistant is provisioned", () => {
    expect(
      onboardingDestinationAfterConsent({
        isLocalHatch: false,
        skipResearch: true,
        env: "staging",
      }),
    ).toBe(routes.onboarding.hatching);
  });

  test("skip-to-chat keeps local hosting on hatching", () => {
    expect(
      onboardingDestinationAfterConsent({
        isLocalHatch: true,
        skipResearch: true,
        env: "dev",
      }),
    ).toBe(routes.onboarding.hatching);
  });

  test("production ignores skip-to-chat and keeps the research destination", () => {
    expect(
      onboardingDestinationAfterConsent({
        isLocalHatch: false,
        skipResearch: true,
        env: "production",
      }),
    ).toBe(routes.onboarding.research);
  });

  test("an already-onboarded assistant skips research on every build", () => {
    expect(
      onboardingDestinationAfterConsent({
        isLocalHatch: false,
        alreadyOnboarded: true,
        env: "production",
      }),
    ).toBe(routes.assistant);
    expect(
      onboardingDestinationAfterConsent({
        isLocalHatch: true,
        skipResearch: true,
        alreadyOnboarded: true,
        env: "staging",
      }),
    ).toBe(routes.assistant);
  });
});

describe("withSkipResearch", () => {
  test("adds skip_research and rewrites a research URL onto hatching", () => {
    expect(
      withSkipResearch(
        `${routes.onboarding.research}?hosting=managed`,
        "staging",
      ),
    ).toBe(
      `${routes.onboarding.hatching}?hosting=managed&${SKIP_RESEARCH_PARAM}=1`,
    );
  });

  test("adds skip_research to an already-hatching destination", () => {
    expect(
      withSkipResearch(`${routes.onboarding.hatching}?hosting=local`, "dev"),
    ).toBe(
      `${routes.onboarding.hatching}?hosting=local&${SKIP_RESEARCH_PARAM}=1`,
    );
  });

  test("adds skip_research to a paid hatch return without dropping post_checkout", () => {
    expect(
      withSkipResearch(
        `${routes.onboarding.hatching}?hosting=vellum-cloud&post_checkout=1`,
        "staging",
      ),
    ).toBe(
      `${routes.onboarding.hatching}?hosting=vellum-cloud&post_checkout=1&${SKIP_RESEARCH_PARAM}=1`,
    );
  });

  test("production leaves the destination unchanged", () => {
    const destination = `${routes.onboarding.research}?hosting=managed`;
    expect(withSkipResearch(destination, "production")).toBe(destination);
  });
});

describe("shouldSkipResearchAfterHatch", () => {
  test("true only when skip_research=1 is present", () => {
    expect(
      shouldSkipResearchAfterHatch(
        new URLSearchParams("skip_research=1"),
        "staging",
      ),
    ).toBe(true);
    expect(
      shouldSkipResearchAfterHatch(new URLSearchParams(), "staging"),
    ).toBe(false);
    expect(
      shouldSkipResearchAfterHatch(
        new URLSearchParams("skip_research=0"),
        "staging",
      ),
    ).toBe(false);
  });

  test("production ignores skip_research even when the param is set", () => {
    expect(
      shouldSkipResearchAfterHatch(
        new URLSearchParams("skip_research=1"),
        "production",
      ),
    ).toBe(false);
  });
});
