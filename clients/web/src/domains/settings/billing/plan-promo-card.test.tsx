/**
 * Tests for PlanPromoCard: the dark, layout-only "promo" card in the billing
 * Plan section — a centered title, optional one-line blurb, and a single CTA.
 * Verifies it renders the title, blurb, and CTA label; omits the blurb node
 * when no blurb is passed; fires `onCtaClick` on click; shows the pending
 * spinner and blocks the click while pending; and forces the dark palette.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";

const { PlanPromoCard } = await import("./plan-promo-card");

afterEach(() => {
  cleanup();
});

describe("PlanPromoCard", () => {
  test("renders the title, blurb, and CTA label", async () => {
    const { findByRole, findByText } = render(
      <PlanPromoCard
        title="Upgrade to Mighty"
        blurb="More power and storage"
        ctaLabel="Power Up"
        onCtaClick={() => {}}
      />,
    );
    expect(await findByText("Upgrade to Mighty")).toBeTruthy();
    expect(await findByText("More power and storage")).toBeTruthy();
    expect(await findByRole("button", { name: "Power Up" })).toBeTruthy();
  });

  test("omits the blurb node when blurb is not provided", () => {
    const { queryByText } = render(
      <PlanPromoCard
        title="Customize"
        ctaLabel="Configure"
        onCtaClick={() => {}}
      />,
    );
    expect(queryByText("More power and storage")).toBeNull();
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
