import { describe, expect, test } from "bun:test";

import { shouldSuppressRootStatusBanner } from "@/utils/status-banner-visibility";
import { routes } from "@/utils/routes";

describe("shouldSuppressRootStatusBanner", () => {
  test("suppresses onboarding funnel routes", () => {
    for (const pathname of [
      routes.onboarding.hosting,
      routes.onboarding.apiKey,
      routes.onboarding.privacy,
      routes.onboarding.prechat,
      routes.onboarding.hatching,
      `${routes.assistant}/onboarding`,
    ]) {
      expect(shouldSuppressRootStatusBanner(pathname, "")).toBe(true);
    }
  });

  test("suppresses setup routes around onboarding", () => {
    for (const pathname of [
      routes.welcome,
      routes.selectAssistant,
      routes.reviewTerms,
    ]) {
      expect(shouldSuppressRootStatusBanner(pathname, "")).toBe(true);
    }
  });

  test("suppresses the onboarding handoff query on the assistant route", () => {
    expect(shouldSuppressRootStatusBanner(routes.assistant, "?onboarding=1")).toBe(
      true,
    );
  });

  test("allows normal app routes", () => {
    expect(shouldSuppressRootStatusBanner(routes.settings.root, "")).toBe(false);
    expect(shouldSuppressRootStatusBanner(routes.assistant, "")).toBe(false);
  });
});
