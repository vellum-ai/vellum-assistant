/**
 * The stand-in for the Credits card: the label contract shared by every card
 * skeleton, plus the nested row groups the real panel lays out below its
 * balance tile.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";

import { BillingPanelSkeleton } from "./billing-panel-skeleton";

afterEach(cleanup);

describe("BillingPanelSkeleton", () => {
  test("keeps the panel's own header and nests its three row groups", () => {
    const { container, getByTestId } = render(<BillingPanelSkeleton />);

    // The real panel paints this header from its first frame, so the swap
    // only replaces the body below it.
    expect(container.textContent).toContain("Extra Usage Credits");

    // Balance tile, then the auto-reload, daily-limit and low-balance rows,
    // the last two behind the panel's own dividers.
    const body = getByTestId("billing-panel-skeleton-body");
    expect(body.children.length).toBe(4);
    expect(body.querySelectorAll(".border-t").length).toBe(2);
  });

  test("announces only when it is given a label", () => {
    const { container, rerender } = render(<BillingPanelSkeleton />);
    expect(container.querySelector('[role="status"]')).toBeNull();

    rerender(<BillingPanelSkeleton label="Loading credit balance" />);
    const announced = container.querySelector('[role="status"]');
    expect(announced?.getAttribute("aria-label")).toBe(
      "Loading credit balance",
    );
  });
});
