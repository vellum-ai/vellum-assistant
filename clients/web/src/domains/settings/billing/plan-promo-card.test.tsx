/**
 * Tests for PlanPromoCard: the dark, layout-only "promo" card in the billing
 * Plan section: a centered title, an optional spec-chip row, and a single CTA.
 * Verifies it renders the title, the chip labels, and the CTA label; omits the
 * chip row when no specs are passed; fires `onCtaClick` on click; shows the
 * pending spinner and blocks the click while pending; and forces the dark
 * palette.
 */

import { Coins, Computer, HardDrive } from "lucide-react";

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";

import type { PlanSpec } from "./plan-spec";

const { PlanPromoCard } = await import("./plan-promo-card");

const MIGHTY_SPECS: PlanSpec[] = [
  { icon: Computer, label: "Small Machine" },
  { icon: Coins, label: "$25 credits" },
  { icon: HardDrive, label: "10 GB" },
];

afterEach(() => {
  cleanup();
});

describe("PlanPromoCard", () => {
  test("renders the title, spec chips, and CTA label", async () => {
    const { findByRole, findByText } = render(
      <PlanPromoCard
        title="Upgrade to Mighty"
        specs={MIGHTY_SPECS}
        ctaLabel="Power Up"
        onCtaClick={() => {}}
      />,
    );
    expect(await findByText("Upgrade to Mighty")).toBeTruthy();
    for (const spec of MIGHTY_SPECS) {
      expect(await findByText(spec.label)).toBeTruthy();
    }
    expect(await findByRole("button", { name: "Power Up" })).toBeTruthy();
  });

  test("omits the chip row when specs are not provided", () => {
    const { queryByText } = render(
      <PlanPromoCard
        title="Customize"
        ctaLabel="Configure"
        onCtaClick={() => {}}
      />,
    );
    for (const spec of MIGHTY_SPECS) {
      expect(queryByText(spec.label)).toBeNull();
    }
  });

  test("omits the chip row when specs is empty", () => {
    const { container } = render(
      <PlanPromoCard
        title="Customize"
        specs={[]}
        ctaLabel="Configure"
        onCtaClick={() => {}}
      />,
    );
    expect(container.querySelector(".flex-wrap")).toBeNull();
  });

  test("fires onCtaClick when the CTA is clicked", async () => {
    let clicks = 0;
    const { findByRole } = render(
      <PlanPromoCard
        title="Upgrade to Mighty"
        ctaLabel="Power Up"
        onCtaClick={() => {
          clicks += 1;
        }}
      />,
    );
    const button = await findByRole("button", { name: "Power Up" });
    fireEvent.click(button);
    expect(clicks).toBe(1);
  });

  test("shows the spinner and blocks the click while pending", async () => {
    let clicks = 0;
    const { container, findByRole } = render(
      <PlanPromoCard
        title="Upgrade to Mighty"
        ctaLabel="Power Up"
        pending
        onCtaClick={() => {
          clicks += 1;
        }}
      />,
    );
    const button = await findByRole("button", { name: "Power Up" });
    expect(button).toHaveProperty("disabled", true);
    expect(container.querySelector(".animate-spin")).not.toBeNull();
    fireEvent.click(button);
    expect(clicks).toBe(0);
  });

  test("forces the dark palette on the root", () => {
    const { container } = render(
      <PlanPromoCard
        title="Upgrade to Mighty"
        ctaLabel="Power Up"
        onCtaClick={() => {}}
      />,
    );
    expect(container.querySelector('[data-theme="dark"]')).not.toBeNull();
  });

  test("applies the passed className and ctaTestId", async () => {
    const { container, findByTestId } = render(
      <PlanPromoCard
        title="Upgrade to Mighty"
        ctaLabel="Power Up"
        className="lg:flex-[2]"
        ctaTestId="promo-cta"
        onCtaClick={() => {}}
      />,
    );
    expect(container.querySelector(".lg\\:flex-\\[2\\]")).not.toBeNull();
    expect(await findByTestId("promo-cta")).toBeTruthy();
  });
});
