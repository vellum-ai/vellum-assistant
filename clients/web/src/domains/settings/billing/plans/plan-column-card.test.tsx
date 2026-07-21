/**
 * Rendering tests for PlanColumnCard's CTA chrome. The `intent` prop selects
 * the button variant (outlined for downgrade) without changing the current /
 * upgrade rendering. The avatar compositor is mocked out — it's a lazy bundle
 * irrelevant to the CTA.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";

mock.module("@/utils/use-bundled-avatar-components", () => ({
  preloadBundledAvatarComponents: () => {},
  useBundledAvatarComponents: () => null,
}));

const { PlanColumnCard } = await import("./plan-column-card");

const baseProps = {
  tierKey: "mighty",
  name: "Mighty",
  tagline: "Starter Pro",
  priceLabel: "$30/month",
  priceCaption: "billed monthly",
  ctaLabel: "Power Up",
  features: ["Feature A"],
  pending: false,
  onCta: () => {},
};

afterEach(() => {
  cleanup();
});

describe("PlanColumnCard CTA", () => {
  test("renders a disabled Current Plan button when isCurrent", () => {
    const { getByRole } = render(
      <PlanColumnCard {...baseProps} isCurrent intent="current" />,
    );
    const button = getByRole("button", { name: "Current Plan" });
    expect(button).toHaveProperty("disabled", true);
  });

  test("renders an outlined CTA with ctaLabel for a downgrade", () => {
    const { getByRole } = render(
      <PlanColumnCard
        {...baseProps}
        isCurrent={false}
        intent="downgrade"
        ctaLabel="Downgrade to Mighty"
      />,
    );
    const button = getByRole("button", { name: "Downgrade to Mighty" });
    expect(button).toHaveProperty("disabled", false);
    // Outlined variant paints a transparent background rather than the
    // primary fill.
    expect(button.className).toContain("bg-transparent");
  });

  test("renders a primary CTA with ctaLabel when intent is omitted", () => {
    const { getByRole } = render(
      <PlanColumnCard {...baseProps} isCurrent={false} />,
    );
    const button = getByRole("button", { name: "Power Up" });
    expect(button).toHaveProperty("disabled", false);
    expect(button.className).toContain("bg-[var(--primary-base)]");
  });
});
