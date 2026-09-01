/**
 * The stand-in for the Invoices card: the collapsed geometry the resolved
 * table mounts with, plus the label contract shared by every card skeleton.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";

import { InvoicesTableSkeleton } from "./invoices-table-skeleton";

afterEach(cleanup);

describe("InvoicesTableSkeleton", () => {
  test("stands in for the collapsed card: header and toggle, no table", () => {
    const { container } = render(<InvoicesTableSkeleton />);

    expect(container.querySelector("h2")).toBeTruthy();
    const toggle = container.querySelector(
      '[data-testid="invoices-toggle-skeleton"]',
    );
    // The regular button height the Show Invoices toggle renders at.
    expect(toggle?.className).toContain("h-8");
    // The table only exists once the section is expanded, so the card stands
    // in with the title and the toggle alone.
    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBe(2);
  });

  test("stands the title in with phrasing content the heading can hold", () => {
    const { container } = render(<InvoicesTableSkeleton />);

    const title = container.querySelector('h2 > [data-slot="skeleton"]');
    expect(title?.tagName).toBe("SPAN");
    // The 20px line the resolved title renders at.
    expect(title?.className).toContain("h-5");
  });

  test("announces only when it is given a label", () => {
    const { container, rerender } = render(<InvoicesTableSkeleton />);
    expect(container.querySelector('[role="status"]')).toBeNull();

    rerender(<InvoicesTableSkeleton label="Loading invoices" />);
    const announced = container.querySelector('[role="status"]');
    expect(announced?.getAttribute("aria-label")).toBe("Loading invoices");
  });
});
