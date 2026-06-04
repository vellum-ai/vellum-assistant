/**
 * Tests for the shared presentational `InlineActivityLink` — the single
 * underlying component for the thought-process link and the single-tool chip.
 * Covers icon/label/chevron rendering, the optional risk badge, the active
 * highlight, and the click contract.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";

import { Brain } from "lucide-react";
import { cleanup, fireEvent, render } from "@testing-library/react";

import { InlineActivityLink } from "@/domains/chat/components/inline-activity-link/inline-activity-link";

afterEach(() => {
  cleanup();
});

const ICON = <Brain data-testid="leading-icon" className="size-4" aria-hidden />;

describe("InlineActivityLink", () => {
  test("renders the leading icon, label, and trailing chevron", () => {
    const { getByTestId, getByText, container } = render(
      <InlineActivityLink
        icon={ICON}
        label="Thought process"
        ariaLabel="View thinking"
        onClick={() => {}}
      />,
    );

    expect(getByTestId("leading-icon")).toBeTruthy();
    expect(getByText("Thought process")).toBeTruthy();
    // Brain (leading) + ChevronRight (trailing).
    expect(container.querySelectorAll("svg").length).toBe(2);
  });

  test("uses the default data-testid", () => {
    const { getByTestId } = render(
      <InlineActivityLink
        icon={ICON}
        label="Thought process"
        ariaLabel="View thinking"
        onClick={() => {}}
      />,
    );
    expect(getByTestId("inline-activity-link")).toBeTruthy();
  });

  test("renders the risk badge only when riskLevel is supplied", () => {
    const { queryByTestId, rerender } = render(
      <InlineActivityLink
        icon={ICON}
        label="Working (bash)"
        ariaLabel="View details"
        onClick={() => {}}
      />,
    );
    expect(queryByTestId("risk-badge")).toBeNull();

    rerender(
      <InlineActivityLink
        icon={ICON}
        label="Working (bash)"
        riskLevel="low"
        ariaLabel="View details"
        onClick={() => {}}
      />,
    );
    expect(queryByTestId("risk-badge")).toBeTruthy();
  });

  test("omits the trailing chevron when showChevron is false", () => {
    const { container } = render(
      <InlineActivityLink
        icon={ICON}
        label="Thought process"
        ariaLabel="View thinking"
        showChevron={false}
        onClick={() => {}}
      />,
    );
    // Only the leading icon remains.
    expect(container.querySelectorAll("svg").length).toBe(1);
  });

  test("applies the active highlight class when active", () => {
    const { getByTestId } = render(
      <InlineActivityLink
        icon={ICON}
        label="Thought process"
        ariaLabel="View thinking"
        active
        onClick={() => {}}
      />,
    );
    const button = getByTestId("inline-activity-link");
    expect(button.getAttribute("data-active")).toBe("true");
    expect(button.className).toContain("bg-[var(--surface-active)]");
  });

  test("fires onClick when clicked", () => {
    const onClick = mock(() => {});
    const { getByLabelText } = render(
      <InlineActivityLink
        icon={ICON}
        label="Thought process"
        ariaLabel="View thinking"
        onClick={onClick}
      />,
    );
    fireEvent.click(getByLabelText("View thinking"));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
