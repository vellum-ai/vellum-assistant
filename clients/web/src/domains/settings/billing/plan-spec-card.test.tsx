/**
 * Tests for PlanSpecCard: the shared, layout-only plan card used for both the
 * light ("current") and dark ("recommended") columns in the billing Plan
 * section. Verifies it renders the name, tagline, and spec chips; forwards
 * `nameTestId`; forces the `data-theme` palette; and omits the divider + chip
 * row when there are no specs.
 *
 * Rendered with `renderToStaticMarkup` (single-pass, no DOM) — so the lazy
 * `PlanTierAvatar` compositor bundle is mocked to a placeholder, keeping the
 * markup deterministic (mirrors plan-card.test.tsx).
 */

import { Coins, HardDrive } from "lucide-react";

import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { PlanSpec } from "@/domains/settings/billing/plan-spec";

// Render avatar placeholders; skip the lazy compositor bundle.
mock.module("@/utils/use-bundled-avatar-components", () => ({
  preloadBundledAvatarComponents: () => {},
  useBundledAvatarComponents: () => null,
}));

const { PlanSpecCard } = await import("./plan-spec-card");

const SPECS: PlanSpec[] = [
  { icon: Coins, label: "$25 credits" },
  { icon: HardDrive, label: "10 GB" },
];

describe("PlanSpecCard", () => {
  test("renders name, tagline, spec labels, and the nameTestId", () => {
    const html = renderToStaticMarkup(
      <PlanSpecCard
        tone="light"
        tierKey="free"
        name="Mighty"
        nameTestId="plan-card-name"
        tagline="A great starter plan"
        specs={SPECS}
      />,
    );
    expect(html).toContain("Mighty");
    expect(html).toContain("A great starter plan");
    expect(html).toContain("$25 credits");
    expect(html).toContain("10 GB");
    expect(html).toContain("plan-card-name");
  });

  test("omits the divider + chip row when specs is null", () => {
    const html = renderToStaticMarkup(
      <PlanSpecCard
        tone="light"
        tierKey="free"
        name="Free"
        specs={null}
      />,
    );
    expect(html).toContain("Free");
    expect(html).not.toContain("$25 credits");
    expect(html).not.toContain("10 GB");
  });

  test("omits the divider + chip row when specs is empty", () => {
    const html = renderToStaticMarkup(
      <PlanSpecCard tone="light" tierKey="free" name="Free" specs={[]} />,
    );
    expect(html).toContain("Free");
    expect(html).not.toContain("$25 credits");
    expect(html).not.toContain("10 GB");
  });

  test("forces data-theme=\"dark\" when tone is dark", () => {
    const html = renderToStaticMarkup(
      <PlanSpecCard
        tone="dark"
        tierKey="free"
        name="Recommended"
        specs={SPECS}
      />,
    );
    expect(html).toContain('data-theme="dark"');
  });

  test("centers the card content when centered is set", () => {
    const html = renderToStaticMarkup(
      <PlanSpecCard
        tone="light"
        tierKey="free"
        name="Free"
        tagline="A great starter plan"
        centered
        specs={null}
      />,
    );
    // The centering utilities land on both the root and the header row.
    expect(html).toContain("justify-center");
    expect(html).toContain("items-center");
  });

  test("renders a wrapping pill for a multiline spec", () => {
    const html = renderToStaticMarkup(
      <PlanSpecCard
        tone="dark"
        tierKey="mighty"
        name="Mighty"
        specs={[
          {
            icon: Coins,
            label: "more credits, storage, and a stronger machine",
            multiline: true,
          },
        ]}
      />,
    );
    expect(html).toContain("more credits, storage, and a stronger machine");
    // A multiline chip wraps (whitespace-normal) and grows vertically (min-h-8).
    expect(html).toContain("whitespace-normal");
    expect(html).toContain("min-h-8");
  });

  test("applies the passed className to the root", () => {
    const html = renderToStaticMarkup(
      <PlanSpecCard
        tone="light"
        tierKey="free"
        name="Free"
        className="lg:flex-[3]"
        specs={null}
      />,
    );
    expect(html).toContain("lg:flex-[3]");
  });
});
