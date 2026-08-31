/**
 * The label contract every card skeleton shares: labelled when the card
 * mounts it on its own, silent when the billing tab's stack composes it and
 * announces all three at once.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";

import { PlanCardSkeleton } from "./plan-card-skeleton";

afterEach(cleanup);

describe("PlanCardSkeleton", () => {
  test("keeps the card heading and stands the layout in with shimmer", () => {
    const { container } = render(<PlanCardSkeleton />);

    expect(container.querySelector("h2")?.textContent).toBe("Plan");
    // Plan name, renewal line, usage bar, and one per plan tile.
    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBe(5);
  });

  test("announces only when it is given a label", () => {
    const { container, rerender } = render(<PlanCardSkeleton />);
    expect(container.querySelector('[role="status"]')).toBeNull();

    rerender(<PlanCardSkeleton label="Loading plan" />);
    const announced = container.querySelector('[role="status"]');
    expect(announced?.getAttribute("aria-label")).toBe("Loading plan");
  });
});
