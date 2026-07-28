/**
 * Tests for `StackedChipsPill` — the generic stacked-chip pill body shared by
 * the subagent / ACP-run / background-task overlays.
 *
 * A stub `renderChip` emits a labelled marker per id so we can assert the
 * visible-chip cap, the "+N" overflow, the chevron direction, the toggle
 * callback, and the pill's aria contract without pulling in any store.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { StackedChipsPill } from "@/domains/chat/process-registry/stacked-chips-pill";

afterEach(() => {
  cleanup();
});

function renderChip(id: string) {
  return <span key={id} data-testid="stacked-chip" data-id={id} />;
}

function ids(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `id-${i}`);
}

describe("StackedChipsPill — chips", () => {
  test("renders all chips and no overflow when ids.length <= max", () => {
    render(
      <StackedChipsPill
        ids={ids(4)}
        renderChip={renderChip}
        max={6}
        expanded={false}
        onToggle={() => {}}
        ariaLabel="Active things"
      />,
    );

    expect(screen.getAllByTestId("stacked-chip").length).toBe(4);
    expect(screen.queryByText(/^\+/)).toBeNull();
  });

  test("renders all chips and no overflow when ids.length === max", () => {
    render(
      <StackedChipsPill
        ids={ids(6)}
        renderChip={renderChip}
        max={6}
        expanded={false}
        onToggle={() => {}}
        ariaLabel="Active things"
      />,
    );

    expect(screen.getAllByTestId("stacked-chip").length).toBe(6);
    expect(screen.queryByText(/^\+/)).toBeNull();
  });

  test("caps visible chips at max and shows +N overflow when ids.length > max", () => {
    render(
      <StackedChipsPill
        ids={ids(8)}
        renderChip={renderChip}
        max={6}
        expanded={false}
        onToggle={() => {}}
        ariaLabel="Active things"
      />,
    );

    // 8 ids, 6 visible → "+2" overflow.
    expect(screen.getAllByTestId("stacked-chip").length).toBe(6);
    expect(screen.getByText("+2")).toBeTruthy();
  });
});

describe("StackedChipsPill — chevron", () => {
  test("shows the down chevron when collapsed and up chevron when expanded", () => {
    const { rerender, container } = render(
      <StackedChipsPill
        ids={ids(2)}
        renderChip={renderChip}
        max={6}
        expanded={false}
        onToggle={() => {}}
        ariaLabel="Active things"
      />,
    );

    expect(container.querySelector(".lucide-chevron-down")).toBeTruthy();
    expect(container.querySelector(".lucide-chevron-up")).toBeNull();

    rerender(
      <StackedChipsPill
        ids={ids(2)}
        renderChip={renderChip}
        max={6}
        expanded
        onToggle={() => {}}
        ariaLabel="Active things"
      />,
    );

    expect(container.querySelector(".lucide-chevron-up")).toBeTruthy();
    expect(container.querySelector(".lucide-chevron-down")).toBeNull();
  });
});

describe("StackedChipsPill — interaction & aria", () => {
  test("invokes onToggle when the pill is clicked", () => {
    let toggles = 0;
    render(
      <StackedChipsPill
        ids={ids(2)}
        renderChip={renderChip}
        max={6}
        expanded={false}
        onToggle={() => {
          toggles += 1;
        }}
        ariaLabel="Active things"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /active things/i }));
    expect(toggles).toBe(1);
  });

  test("exposes ariaLabel and reflects expanded via aria-expanded", () => {
    const { rerender } = render(
      <StackedChipsPill
        ids={ids(2)}
        renderChip={renderChip}
        max={6}
        expanded={false}
        onToggle={() => {}}
        ariaLabel="Active things"
      />,
    );

    const pill = screen.getByRole("button", { name: /active things/i });
    expect(pill.getAttribute("aria-label")).toBe("Active things");
    expect(pill.getAttribute("aria-expanded")).toBe("false");

    rerender(
      <StackedChipsPill
        ids={ids(2)}
        renderChip={renderChip}
        max={6}
        expanded
        onToggle={() => {}}
        ariaLabel="Active things"
      />,
    );
    expect(
      screen.getByRole("button", { name: /active things/i }).getAttribute("aria-expanded"),
    ).toBe("true");
  });
});
