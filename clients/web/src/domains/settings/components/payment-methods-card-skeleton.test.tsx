/**
 * The stand-in for the Payment Method card: the label contract shared by every
 * card skeleton, plus the header slot the resolved card hands back and forth
 * with it.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";

import { PaymentMethodsCardSkeleton } from "./payment-methods-card-skeleton";

afterEach(cleanup);

describe("PaymentMethodsCardSkeleton", () => {
  test("reserves the header action slot at button height", () => {
    const { container } = render(<PaymentMethodsCardSkeleton />);

    const slot = container.querySelector(
      '[data-testid="payment-methods-action-slot"]',
    );
    expect(slot?.className).toContain("h-8");
    // Title and action placeholders, plus the one card row.
    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBe(3);
  });

  test("stands the title in with phrasing content the heading can hold", () => {
    const { container } = render(<PaymentMethodsCardSkeleton />);

    const title = container.querySelector('h2 > [data-slot="skeleton"]');
    expect(title?.tagName).toBe("SPAN");
    // The 20px line the resolved title renders at.
    expect(title?.className).toContain("h-5");
  });

  test("announces only when it is given a label", () => {
    const { container, rerender } = render(<PaymentMethodsCardSkeleton />);
    expect(container.querySelector('[role="status"]')).toBeNull();

    rerender(<PaymentMethodsCardSkeleton label="Loading payment method" />);
    const announced = container.querySelector('[role="status"]');
    expect(announced?.getAttribute("aria-label")).toBe(
      "Loading payment method",
    );
  });
});
