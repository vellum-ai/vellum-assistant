import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";

import {
  ContentReveal,
  SkeletonCardBlock,
  SkeletonLines,
} from "./billing-loading";

afterEach(cleanup);

describe("ContentReveal", () => {
  test("renders its children", () => {
    const { getByText } = render(
      <ContentReveal>
        <p>Resolved content</p>
      </ContentReveal>,
    );
    expect(getByText("Resolved content")).toBeDefined();
  });

  test("passes the className through to the wrapper", () => {
    const { container } = render(
      <ContentReveal className="flex flex-col gap-4">
        <span>Body</span>
      </ContentReveal>,
    );
    expect(container.firstElementChild?.className).toContain(
      "flex flex-col gap-4",
    );
  });
});

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

  test("omits aria-label when no label is given", () => {
    const { getByRole } = render(<SkeletonLines lines={1} />);
    expect(getByRole("status").hasAttribute("aria-label")).toBe(false);
  });

  test("applies the line and container classNames", () => {
    const { container, getByRole } = render(
      <SkeletonLines lines={1} lineClassName="h-10 rounded-lg" className="py-2" />,
    );
    expect(getByRole("status").className).toContain("py-2");
    const row = container.querySelector('[data-slot="skeleton"]');
    expect(row?.className).toContain("h-10 rounded-lg");
  });
});

describe("SkeletonCardBlock", () => {
  test("renders its shimmer rows inside a card", () => {
    const { container } = render(<SkeletonCardBlock />);
    const card = container.querySelector('[data-slot="card"]');
    expect(card).not.toBeNull();
    expect(card?.querySelectorAll('[data-slot="skeleton"]').length).toBe(3);
  });

  test("labels the block when a label is given", () => {
    const { getByRole } = render(<SkeletonCardBlock label="Loading billing" />);
    expect(getByRole("status").getAttribute("aria-label")).toBe(
      "Loading billing",
    );
  });
});
