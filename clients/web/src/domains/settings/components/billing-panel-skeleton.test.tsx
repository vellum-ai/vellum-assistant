/**
 * The stand-in for the whole Credits card, which only the billing tab's
 * skeleton stack mounts: the panel's own header and the nested row groups it
 * lays out below its balance tile.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";

import { BillingPanelSkeleton } from "./billing-panel-skeleton";

afterEach(cleanup);

describe("BillingPanelSkeleton", () => {
  test("keeps the panel's own header and nests its three row groups", () => {
    const { container, getByTestId } = render(<BillingPanelSkeleton />);

    // The real panel paints this header from the first frame, so only the
    // body below it is ever stood in for.
    expect(container.textContent).toContain("Extra Usage Credits");

    // The header, then the balance tile and the auto-reload, daily-limit and
    // low-balance rows, the last two behind the panel's own dividers. The
    // card's own body is the only wrapper the skeleton sits inside.
    const card = getByTestId("billing-panel-skeleton");
    const body = card.querySelector('[data-slot="card-body"]');
    expect(body?.children.length).toBe(5);
    expect(card.querySelectorAll(".border-t").length).toBe(2);
  });

  test("stays silent so the stack around it announces once", () => {
    const { container } = render(<BillingPanelSkeleton />);

    expect(container.querySelector('[role="status"]')).toBeNull();
  });
});
