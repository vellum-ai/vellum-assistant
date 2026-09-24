import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";

import { AnimatedStatSquare, formatNumber } from "./animated-stat-square";

afterEach(cleanup);

describe("AnimatedStatSquare", () => {
  test("counts toward the target through the library's tile", () => {
    render(
      <AnimatedStatSquare
        icon={null}
        label="Input"
        target={257_400}
        format={formatNumber}
      />,
    );

    expect(screen.getByText("257.4K")).toBeDefined();
    expect(screen.getByText("Input")).toBeDefined();
    // Through `StatSquare` rather than a tile of its own: this component adds
    // the count and nothing a person sees.
    expect(document.querySelector('[data-slot="stat-square"]')).not.toBeNull();
  });

  test("formats a target under a thousand without a suffix", () => {
    render(
      <AnimatedStatSquare
        icon={null}
        label="Agents"
        target={7}
        format={formatNumber}
      />,
    );

    expect(screen.getByText("7")).toBeDefined();
  });
});
