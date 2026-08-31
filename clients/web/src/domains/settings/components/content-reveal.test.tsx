import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";

import { ContentReveal } from "./content-reveal";

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
