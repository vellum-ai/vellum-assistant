import { describe, expect, test } from "bun:test";

import {
  ONBOARDING_HEADING,
  buildOnboardingSection,
  upsertOnboardingSection,
} from "@/lib/onboarding/prechat-profile.js";

describe("prechat onboarding profile markdown", () => {
  test("builds the managed onboarding section", () => {
    expect(
      buildOnboardingSection({
        preferredName: "Alex",
        commonWork: [
          "builds code, apps, or tools",
          "writes docs, emails, or content",
        ],
        dailyTools: ["GitHub", "Linear", "Slack"],
      }),
    ).toBe(
      [
        ONBOARDING_HEADING,
        "",
        "- **Preferred name:** Alex",
        "- **Common work:** builds code, apps, or tools; writes docs, emails, or content",
        "- **Daily tools:** GitHub, Linear, Slack",
        "",
      ].join("\n"),
    );
  });

  test("creates a profile file when no content exists", () => {
    const section = buildOnboardingSection({
      preferredName: "Alex",
      commonWork: [],
      dailyTools: ["GitHub"],
    });

    expect(upsertOnboardingSection(null, section)).toBe(
      [
        "# User Profile",
        "",
        ONBOARDING_HEADING,
        "",
        "- **Preferred name:** Alex",
        "- **Daily tools:** GitHub",
        "",
      ].join("\n"),
    );
  });

  test("replaces an existing onboarding section and preserves later sections", () => {
    const existing = [
      "# User Profile",
      "",
      "- **Name:** Alex",
      "",
      ONBOARDING_HEADING,
      "",
      "- **Preferred name:** Old",
      "",
      "## Preferences",
      "",
      "- Likes dark mode",
      "",
    ].join("\n");
    const section = buildOnboardingSection({
      preferredName: "Alex",
      commonWork: ["handles life admin"],
      dailyTools: [],
    });

    const updated = upsertOnboardingSection(existing, section);

    expect(updated).toContain("- **Name:** Alex");
    expect(updated).toContain("- **Preferred name:** Alex");
    expect(updated).toContain("- **Common work:** handles life admin");
    expect(updated).toContain("## Preferences");
    expect(updated).toContain("- Likes dark mode");
    expect(updated).not.toContain("**Preferred name:** Old");
  });
});
