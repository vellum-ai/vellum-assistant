import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";

import { SkeletonCardBlock } from "./skeleton-card-block";

afterEach(cleanup);

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
