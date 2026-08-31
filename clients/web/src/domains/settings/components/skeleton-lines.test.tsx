import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";

import { SkeletonLines } from "./skeleton-lines";

afterEach(cleanup);

describe("SkeletonLines", () => {
  test("renders one shimmer row per requested line", () => {
    const { container } = render(<SkeletonLines lines={3} />);
    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBe(3);
  });

  test("marks the shimmer rows aria-hidden", () => {
    const { container } = render(<SkeletonLines lines={2} />);
    const rows = container.querySelectorAll('[data-slot="skeleton"]');
    for (const row of rows) {
      expect(row.getAttribute("aria-hidden")).toBe("true");
    }
  });

  test("announces the region when a label is given", () => {
    const { getByRole } = render(
      <SkeletonLines lines={2} label="Loading invoices" />,
    );
    const status = getByRole("status");
    expect(status.getAttribute("aria-label")).toBe("Loading invoices");
  });

  test("stays out of the accessibility tree when no label is given", () => {
    const { container, queryByRole } = render(<SkeletonLines lines={1} />);
    expect(queryByRole("status")).toBeNull();
    const stack = container.firstElementChild;
    expect(stack?.hasAttribute("role")).toBe(false);
    expect(stack?.hasAttribute("aria-label")).toBe(false);
  });

  test("applies the line and container classNames", () => {
    const { container } = render(
      <SkeletonLines
        lines={1}
        lineClassName="h-10 rounded-lg"
        className="py-2"
      />,
    );
    expect(container.firstElementChild?.className).toContain("py-2");
    const row = container.querySelector('[data-slot="skeleton"]');
    expect(row?.className).toContain("h-10 rounded-lg");
  });

  test("leaves the row height to the caller", () => {
    const { container } = render(<SkeletonLines lines={1} />);
    expect(
      container.querySelector('[data-slot="skeleton"]')?.className,
    ).not.toContain("h-4");
  });
});
