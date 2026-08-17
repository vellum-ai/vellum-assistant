/**
 * What the collapsed rail renders *during* the collapse animation.
 *
 * This lives in `clients/web` rather than beside `SideMenu` because the bug it
 * guards is the seam between the two packages: the app swaps its tree to the
 * rail the instant `collapsed` flips, while the design library holds
 * `contentCollapsed` back for the width transition. Reproducing it needs a
 * real DOM and a rerender, which `clients/web` has wired (happy-dom via
 * `bunfig.toml`) and the design library's static-markup tests do not.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { Pin } from "lucide-react";

import { SideMenu } from "@vellumai/design-library";

afterEach(() => {
  cleanup();
});

/** A circle tile and an ordinary row, so the two collapse timings show up side by side. */
function Rail({ collapsed }: { collapsed: boolean }) {
  return (
    <SideMenu ariaLabel="Primary" collapsed={collapsed}>
      <SideMenu.Body>
        <SideMenu.Item
          icon={Pin}
          label="Pinned"
          shape="tile"
          showCollapsedTooltip
          indicator={<span data-slot="dot" />}
        />
        <SideMenu.Item icon={Pin} label="Preferences" />
      </SideMenu.Body>
    </SideMenu>
  );
}

/**
 * Rows by position, not by name: a collapsed row is named by `aria-label` and
 * an expanded one by its visible text, and which of those applies is the very
 * thing under test.
 */
function rows(): HTMLElement[] {
  return [
    ...document.querySelectorAll<HTMLElement>('[data-slot="side-menu-item"]'),
  ];
}

describe("collapsing an expanded rail", () => {
  test("a circle tile is round and dotted on the very first collapsed render", () => {
    const { rerender } = render(<Rail collapsed={false} />);
    rerender(<Rail collapsed />);

    /* A circle tile reads the rail's immediate collapsed flag, not the
       delayed `contentCollapsed` that lets an ordinary row's label linger.
       Keying it off the delayed one leaves the rail's section tiles as
       full-width labelled rows inside a 48px column for the 150ms of the
       width transition, with no activity dot and no tooltip. No timers are
       advanced here on purpose: the first collapsed paint is the only window
       in which the two flags disagree. */
    const [circle] = rows();
    expect(circle!.className).toContain("rounded-full");
    expect(circle!.className).toContain("size-[var(--side-menu-tile-size)]");
    expect(circle!.className).not.toContain("w-full");
    expect(circle!.querySelector('[data-slot="dot"]')).not.toBeNull();
    // The label is the tell: a visible one means it is still an expanded row.
    expect(circle!.textContent).toBe("");
    // Collapsed rows carry their name on the attribute, having no visible text.
    expect(circle!.getAttribute("aria-label")).toBe("Pinned");
  });

  test("an ordinary row still lingers, which is what the delay is for", () => {
    const { rerender } = render(<Rail collapsed={false} />);
    rerender(<Rail collapsed />);

    /* The fix is scoped to circle tiles. A default-shape row keeps its label
       through the transition so it slides out under the narrowing rail rather
       than vanishing a frame before it. If this starts failing, the fix
       leaked out of its scope and every SideMenu consumer's collapse
       animation changed with it. */
    const [, ordinary] = rows();
    expect(ordinary!.textContent).toContain("Preferences");
    expect(ordinary!.className).not.toContain("rounded-full");
  });

  test("expanding puts the circle tile back to a labelled row immediately", () => {
    const { rerender } = render(<Rail collapsed />);
    rerender(<Rail collapsed={false} />);

    // Expanding is the direction the library never delayed, and the circle is
    // collapsed-only geometry, so the row comes straight back.
    const [circle] = rows();
    expect(circle!.className).not.toContain("rounded-full");
    expect(circle!.textContent).toContain("Pinned");
    // Named by its visible label now, so the attribute would be a duplicate.
    expect(circle!.getAttribute("aria-label")).toBeNull();
  });

  test("mounting straight into a collapsed rail is round too", () => {
    render(<Rail collapsed />);
    // The case the Storybook story covers, and the one that hid the bug:
    // `contentCollapsed` seeds from `collapsed`, so there is no window here.
    const [circle] = rows();
    expect(circle!.className).toContain("rounded-full");
    expect(circle!.textContent).toBe("");
  });
});
