import { afterEach, describe, expect, test } from "bun:test";

import { cleanup, render, screen } from "@testing-library/react";

import { ThinkingChip } from "@/domains/chat/components/web-search/thinking-chip.js";

afterEach(() => {
  cleanup();
});

describe("ThinkingChip", () => {
  test("renders children text and the default Brain icon", () => {
    const { container } = render(
      <ThinkingChip>Thinking about the next step</ThinkingChip>,
    );

    expect(screen.getByText("Thinking about the next step")).toBeTruthy();

    // lucide-react adds a `lucide-brain` class to the rendered <svg>.
    const brainIcon = container.querySelector("svg.lucide-brain");
    expect(brainIcon).not.toBeNull();
  });

  test("renders the supplied icon override and omits the default Brain icon", () => {
    const { container } = render(
      <ThinkingChip icon={<span data-testid="custom-icon">🤔</span>}>
        Critical thinking
      </ThinkingChip>,
    );

    expect(screen.getByTestId("custom-icon")).toBeTruthy();
    expect(screen.getByText("Critical thinking")).toBeTruthy();
    expect(container.querySelector("svg.lucide-brain")).toBeNull();
  });

  test("merges a caller-supplied className onto the outer pill", () => {
    const { container } = render(
      <ThinkingChip className="custom-class">Hello</ThinkingChip>,
    );

    const outer = container.firstElementChild;
    expect(outer).not.toBeNull();
    expect(outer?.className).toContain("custom-class");
    // Sanity: the base outline-pill classes are still present after merge.
    expect(outer?.className).toContain("border-[var(--border-base)]");
    expect(outer?.className).toContain("bg-[var(--surface-overlay)]");
  });
});
