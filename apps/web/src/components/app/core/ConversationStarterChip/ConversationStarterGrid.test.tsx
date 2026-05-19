/**
 * Tests for the ConversationStarterGrid primitive.
 *
 * The web workspace does not have @testing-library/react. We mirror the
 * "no DOM test harness" convention used by `ConversationStarterChip.test.tsx`
 * and exercise behavior through `renderToStaticMarkup` plus direct
 * invocation of the rendered React tree.
 */

import { describe, expect, mock, test } from "bun:test";
import {
  Children,
  createElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  ConversationStarterChip,
  type ConversationStarterChipProps,
} from "@/components/app/core/ConversationStarterChip/ConversationStarterChip.js";
import {
  ConversationStarterGrid,
  type ConversationStarter,
  type ConversationStarterGridProps,
} from "@/components/app/core/ConversationStarterChip/ConversationStarterGrid.js";

const STARTERS: readonly ConversationStarter[] = [
  { id: "a", label: "Plan my week", prompt: "Plan my week." },
  { id: "b", label: "Summarize my unread email", prompt: "Summarize my unread email." },
  { id: "c", label: "Review my open PRs", prompt: "Review my open PRs." },
  { id: "d", label: "Draft release notes", prompt: "Draft release notes." },
  { id: "e", label: "Brainstorm names", prompt: "Brainstorm names." },
  { id: "f", label: "Write a status update", prompt: "Write a status update." },
] as const;

/**
 * Calls the grid's render fn directly and returns its React element tree
 * (or `null` for the empty-array branch). This lets us reach into the
 * rendered chips and invoke their `onSelect` props without a DOM.
 */
function renderGrid(
  props: ConversationStarterGridProps,
): ReactElement | null {
  return ConversationStarterGrid(props) as ReactElement | null;
}

function getChipChildren(
  tree: ReactElement,
): ReactElement<ConversationStarterChipProps>[] {
  // The grid renders a single <div> whose children are the chips.
  const childrenProp = (tree.props as { children?: ReactNode }).children;
  return Children.toArray(childrenProp).filter(
    (child): child is ReactElement<ConversationStarterChipProps> =>
      isValidElement(child) && child.type === ConversationStarterChip,
  );
}

describe("ConversationStarterGrid rendering", () => {
  test("renders nothing when starters is empty", () => {
    const tree = renderGrid({ starters: [], onSelect: () => {} });
    expect(tree).toBeNull();

    const html = renderToStaticMarkup(
      createElement(ConversationStarterGrid, {
        starters: [],
        onSelect: () => {},
      }),
    );
    // No grid wrapper at all.
    expect(html).toBe("");
  });

  test("renders one chip per starter, capped at maxVisible (defaults to 4)", () => {
    const tree = renderGrid({ starters: STARTERS, onSelect: () => {} });
    expect(tree).not.toBeNull();
    const chips = getChipChildren(tree!);
    expect(chips).toHaveLength(4);
    // Order is preserved (server strongest-first).
    expect(chips.map((chip) => chip.props.label)).toEqual([
      STARTERS[0]!.label,
      STARTERS[1]!.label,
      STARTERS[2]!.label,
      STARTERS[3]!.label,
    ]);
  });

  test("respects an explicit maxVisible override", () => {
    const tree = renderGrid({
      starters: STARTERS,
      onSelect: () => {},
      maxVisible: 2,
    });
    const chips = getChipChildren(tree!);
    expect(chips).toHaveLength(2);
  });

  test("renders fewer chips when starters.length < maxVisible", () => {
    const tree = renderGrid({
      starters: STARTERS.slice(0, 3),
      onSelect: () => {},
    });
    const chips = getChipChildren(tree!);
    expect(chips).toHaveLength(3);
  });

  test("uses a 2-column grid wrapper", () => {
    const html = renderToStaticMarkup(
      createElement(ConversationStarterGrid, {
        starters: STARTERS.slice(0, 2),
        onSelect: () => {},
      }),
    );
    expect(html).toContain("grid-cols-2");
    expect(html).toContain("gap-3");
  });

  test("emits an aria-label of `Send: <label>` on each chip", () => {
    const tree = renderGrid({
      starters: STARTERS.slice(0, 2),
      onSelect: () => {},
    });
    const chips = getChipChildren(tree!);
    expect(chips[0]!.props["aria-label"]).toBe(`Send: ${STARTERS[0]!.label}`);
    expect(chips[1]!.props["aria-label"]).toBe(`Send: ${STARTERS[1]!.label}`);
  });
});

describe("ConversationStarterGrid onSelect", () => {
  test("invokes onSelect with the full starter object on chip click", () => {
    const onSelect = mock((_starter: ConversationStarter) => {});
    const tree = renderGrid({
      starters: STARTERS.slice(0, 3),
      onSelect,
    });
    const chips = getChipChildren(tree!);
    // Simulate a click on the second chip.
    chips[1]!.props.onSelect();
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(STARTERS[1]!);
  });
});
