/**
 * The stand-in for the Credits balance tile: the label contract every card
 * skeleton shares, and the tile shape the resolved `StatSquare` replaces.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";

import { BillingPanelBalanceSkeleton } from "./billing-panel-balance-skeleton";

afterEach(cleanup);

describe("BillingPanelBalanceSkeleton", () => {
  test("stands the tile in with its icon, value and label placeholders", () => {
    const { container } = render(<BillingPanelBalanceSkeleton />);

    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBe(3);
  });

  test("stands each slot in with phrasing content the tile can hold", () => {
    const { container } = render(<BillingPanelBalanceSkeleton />);

    const placeholders = Array.from(
      container.querySelectorAll('[data-slot="skeleton"]'),
    );
    expect(placeholders.length).toBe(3);
    for (const placeholder of placeholders) {
      expect(placeholder.tagName).toBe("SPAN");
    }
  });

  test("announces only when it is given a label", () => {
    const { container, rerender } = render(<BillingPanelBalanceSkeleton />);
    expect(container.querySelector('[role="status"]')).toBeNull();

    rerender(<BillingPanelBalanceSkeleton label="Loading credit balance" />);
    const announced = container.querySelector('[role="status"]');
    expect(announced?.getAttribute("aria-label")).toBe(
      "Loading credit balance",
    );
  });
});
