/**
 * Tests for PlanSpecCard: the layout-only current-plan card in the billing
 * "Plan" section. Verifies it renders the name and spec chips; forwards
 * `nameTestId`; forces the light `data-theme` palette; centers its content on
 * both axes; and brackets the header row with a divider both above and below
 * only when spec chips are present (otherwise just the centered header row).
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

/** Counts non-overlapping occurrences of `needle` in `haystack`. */
function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("PlanSpecCard", () => {
  test("renders the name, spec labels, and forwards the nameTestId", () => {
    const html = renderToStaticMarkup(
      <PlanSpecCard
        tierKey="mighty"
        name="Mighty"
        nameTestId="plan-card-name"
        specs={SPECS}
      />,
    );
    expect(html).toContain("Mighty");
    expect(html).toContain("$25 credits");
    expect(html).toContain("10 GB");
    expect(html).toContain("plan-card-name");
  });

  test("forces the light data-theme scope", () => {
    const html = renderToStaticMarkup(
      <PlanSpecCard tierKey="mighty" name="Mighty" specs={SPECS} />,
    );
    expect(html).toContain('data-theme="light"');
  });

  test("centers its content on both axes", () => {
    const html = renderToStaticMarkup(
      <PlanSpecCard tierKey="free" name="Free" specs={null} />,
    );
    expect(html).toContain("items-center");
    expect(html).toContain("justify-center");
  });

  test("brackets the header row with a divider both above and below when specs exist", () => {
    const html = renderToStaticMarkup(
      <PlanSpecCard tierKey="mighty" name="Mighty" specs={SPECS} />,
    );
    // A divider both above and below the header row → two divider rules.
    expect(count(html, "bg-[var(--border-base)]")).toBe(2);
    // The chip row is centered.
    expect(html).toContain("justify-center");
  });

  test("omits the dividers + chip row when specs is null", () => {
    const html = renderToStaticMarkup(
      <PlanSpecCard tierKey="free" name="Free" specs={null} />,
    );
    expect(html).toContain("Free");
    expect(html).not.toContain("bg-[var(--border-base)]");
    expect(html).not.toContain("$25 credits");
    expect(html).not.toContain("10 GB");
  });

  test("omits the dividers + chip row when specs is empty", () => {
    const html = renderToStaticMarkup(
      <PlanSpecCard tierKey="free" name="Free" specs={[]} />,
    );
    expect(html).toContain("Free");
    expect(html).not.toContain("bg-[var(--border-base)]");
    expect(html).not.toContain("$25 credits");
    expect(html).not.toContain("10 GB");
  });

  test("renders the tag next to the name", () => {
    const html = renderToStaticMarkup(
      <PlanSpecCard
        tierKey="free"
        name="Free"
        tag={<span>Current Plan</span>}
        specs={null}
      />,
    );
    expect(html).toContain("Free");
    expect(html).toContain("Current Plan");
  });

  test("renders a wrapping pill for a multiline spec", () => {
    const html = renderToStaticMarkup(
      <PlanSpecCard
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
        tierKey="free"
        name="Free"
        className="lg:flex-[3]"
        specs={null}
      />,
    );
    expect(html).toContain("lg:flex-[3]");
  });
});
