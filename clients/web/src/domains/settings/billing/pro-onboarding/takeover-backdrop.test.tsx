/**
 * Tests for the presentational takeover backdrop. The visual contract is the
 * blur radius and the over-scan, so those are asserted directly.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";

import { TakeoverBackdrop } from "./takeover-backdrop";

afterEach(cleanup);

describe("TakeoverBackdrop", () => {
  test("renders the passed image URL with an empty alt", () => {
    const { container } = render(
      <TakeoverBackdrop imageUrl="https://cdn.test/avatar.png" />,
    );
    const image = container.querySelector("img");
    expect(image?.getAttribute("src")).toBe("https://cdn.test/avatar.png");
    expect(image?.getAttribute("alt")).toBe("");
  });

  test("hides the decorative layer from the accessibility tree", () => {
    const { getByTestId } = render(
      <TakeoverBackdrop imageUrl="https://cdn.test/avatar.png" />,
    );
    expect(getByTestId("takeover-backdrop").getAttribute("aria-hidden")).toBe(
      "true",
    );
  });

  test("blurs and over-scans the image", () => {
    const { container } = render(
      <TakeoverBackdrop imageUrl="https://cdn.test/avatar.png" />,
    );
    const image = container.querySelector("img");
    expect(image?.style.filter).toBe("blur(60px)");
    // Over-scan is 2x the 60px radius per side, so each axis grows by 240px.
    expect(image?.style.width.replace(/\s/g, "")).toBe("calc(100%+240px)");
    expect(image?.style.height.replace(/\s/g, "")).toBe("calc(100%+240px)");
  });
});
