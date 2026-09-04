import { describe, expect, test } from "bun:test";
import { fireEvent, render } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";

import { ACTION_WIDTH_PX } from "@/hooks/use-swipe-to-reveal";
import { SwipeActionReveal } from "@/components/swipe-action-reveal";
import type { SwipeAction } from "@/hooks/use-swipe-to-reveal";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const noopAction: SwipeAction = {
  id: "test",
  label: "Test",
  icon: () => null,
  onSelect: () => {},
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ACTION_WIDTH_PX", () => {
  test("is 72px (standard iOS action width)", () => {
    expect(ACTION_WIDTH_PX).toBe(72);
  });
});

describe("SwipeActionReveal", () => {
  test("is a passthrough on desktop (disabled) — no action buttons", () => {
    const html = renderToStaticMarkup(
      <SwipeActionReveal enabled={false} trailingActions={[noopAction]}>
        <div data-testid="child">Row content</div>
      </SwipeActionReveal>,
    );
    // When disabled, children render directly without the swipe wrapper.
    // No action buttons should be present.
    expect(html).toContain("Row content");
    expect(html).not.toContain('aria-label="Test"');
  });

  test("renders trailing action buttons when enabled", () => {
    const html = renderToStaticMarkup(
      <SwipeActionReveal enabled={true} trailingActions={[noopAction]}>
        <div>Row content</div>
      </SwipeActionReveal>,
    );
    expect(html).toContain('aria-label="Test"');
    expect(html).toContain("Test");
  });

  test("each action layer is the item's whole box, in the item's shape", () => {
    const html = renderToStaticMarkup(
      <SwipeActionReveal
        enabled={true}
        leadingActions={[{ ...noopAction, id: "pin", label: "Pin" }]}
        trailingActions={[{ ...noopAction, id: "archive", label: "Archive" }]}
      >
        <div>Row content</div>
      </SwipeActionReveal>,
    );

    // A layer is the same size and shape as the item it sits behind, so what
    // the item uncovers as it slides is the layer's own rounded end. Found by
    // the action each one holds.
    const host = document.createElement("div");
    host.innerHTML = html;
    for (const label of ["Pin", "Archive"]) {
      const layer = host.querySelector(
        `button[aria-label="${label}"]`,
      )!.parentElement!;
      expect(layer.className).toContain("inset-0");
      expect(layer.className).toContain("rounded-[inherit]");
      // Hidden at rest: painted under the item it would show at the item's
      // edge, as a hairline around a pill and as corners past a rounded row.
      expect(layer.style.visibility).toBe("hidden");
    }
  });

  test("the revealed layer stays painted until the item has slid back", () => {
    const { container, unmount } = render(
      <SwipeActionReveal
        enabled={true}
        trailingActions={[{ ...noopAction, label: "Archive" }]}
      >
        <div>Row content</div>
      </SwipeActionReveal>,
    );
    const row = container.querySelector<HTMLElement>(
      "[data-swipe-action-row]",
    )!;
    const layer = container.querySelector(
      'button[aria-label="Archive"]',
    )!.parentElement!;
    const item = row.lastElementChild as HTMLElement;
    const touch = (clientX: number) => [
      { identifier: 1, clientX, clientY: 10 },
    ];

    expect(layer.style.visibility).toBe("hidden");

    fireEvent.touchStart(row, { touches: touch(100) });
    fireEvent.touchMove(row, { touches: touch(80) });
    expect(layer.style.visibility).toBe("visible");

    // Released short of the commit threshold, so the item slides back. The
    // offset is zero at once; the layer holds until the slide has ended, or
    // the box behind it would show for the length of the transition.
    fireEvent.touchEnd(row, { touches: [], changedTouches: touch(80) });
    expect(item.style.transform).toBe("translateX(0px)");
    expect(layer.style.visibility).toBe("visible");

    fireEvent.transitionEnd(item);
    expect(layer.style.visibility).toBe("hidden");
    unmount();
  });

  test("the content layer paints no fill of its own", () => {
    const html = renderToStaticMarkup(
      <SwipeActionReveal enabled={true} trailingActions={[noopAction]}>
        <div>Row content</div>
      </SwipeActionReveal>,
    );

    // A fill here is the row's full width whatever shape the row is, so it
    // reads as a band behind any content that does not fill its box, such as
    // a `w-fit` pill. The clip hides the actions, so there is nothing for a
    // fill to cover and no surface for a host to name.
    expect(html).not.toContain("--swipe-reveal-bg");
    expect(html).not.toContain("--surface-overlay");
  });

  test("the item is not clipped and the wrapper paints nothing", () => {
    const html = renderToStaticMarkup(
      <SwipeActionReveal enabled={true} trailingActions={[noopAction]}>
        <div data-testid="content">Row content</div>
      </SwipeActionReveal>,
    );

    // The item paints its own surface and slides freely; whatever has an edge
    // (a card, the drawer) clips at that edge. A clip or a fill between the
    // root and the item would cut it at its own edge or band it.
    const host = document.createElement("div");
    host.innerHTML = html;
    const root = host.firstElementChild!;
    let node = host.querySelector('[data-testid="content"]')!.parentElement;
    while (node && node !== root.parentElement) {
      expect(node.className).not.toContain("overflow-hidden");
      expect(node.className).not.toMatch(/(^|\s)bg-/);
      expect(node.style.background).toBe("");
      node = node.parentElement;
    }
  });

  test("keeps its mark when a parent hands the row a slot name", () => {
    // What `ContextMenu.Trigger` does with `asChild`, which is how the
    // pinned-app pill mounts: it clones the row and passes its own props down.
    // A mark sharing the `data-slot` channel loses it to that name, and a row
    // the drawer's swipe-to-close cannot see is one it fights for every
    // horizontal drag.
    const html = renderToStaticMarkup(
      <SwipeActionReveal
        enabled={true}
        trailingActions={[noopAction]}
        data-slot="context-menu-trigger"
      >
        <div>Row content</div>
      </SwipeActionReveal>,
    );

    const host = document.createElement("div");
    host.innerHTML = html;
    const root = host.firstElementChild;

    expect(root?.hasAttribute("data-swipe-action-row")).toBe(true);
    // The parent keeps its own name too: nothing has to lose here.
    expect(root?.getAttribute("data-slot")).toBe("context-menu-trigger");
  });

  test("renders leading and trailing action buttons", () => {
    const leadingAction: SwipeAction = {
      id: "pin",
      label: "Pin",
      icon: () => null,
      onSelect: () => {},
    };
    const trailingAction: SwipeAction = {
      id: "archive",
      label: "Archive",
      icon: () => null,
      onSelect: () => {},
      variant: "destructive",
    };
    const html = renderToStaticMarkup(
      <SwipeActionReveal
        enabled={true}
        leadingActions={[leadingAction]}
        trailingActions={[trailingAction]}
      >
        <div>Row content</div>
      </SwipeActionReveal>,
    );
    expect(html).toContain('aria-label="Pin"');
    expect(html).toContain('aria-label="Archive"');
  });

  test("does not render action buttons when no actions provided", () => {
    const html = renderToStaticMarkup(
      <SwipeActionReveal enabled={true}>
        <div>Row content</div>
      </SwipeActionReveal>,
    );
    // No buttons should be in the output.
    expect(html).not.toContain("<button");
  });

  test("destructive action uses danger color", () => {
    const action: SwipeAction = {
      id: "archive",
      label: "Archive",
      icon: () => null,
      onSelect: () => {},
      variant: "destructive",
    };
    const html = renderToStaticMarkup(
      <SwipeActionReveal enabled={true} trailingActions={[action]}>
        <div>Row content</div>
      </SwipeActionReveal>,
    );
    expect(html).toContain("var(--system-negative-strong)");
  });

  test("non-destructive action uses primary color", () => {
    const action: SwipeAction = {
      id: "pin",
      label: "Pin",
      icon: () => null,
      onSelect: () => {},
    };
    const html = renderToStaticMarkup(
      <SwipeActionReveal enabled={true} leadingActions={[action]}>
        <div>Row content</div>
      </SwipeActionReveal>,
    );
    expect(html).toContain("var(--primary-base)");
    expect(html).not.toContain("var(--danger-base)");
  });

  test("content layer has translateX(0px) at rest", () => {
    const html = renderToStaticMarkup(
      <SwipeActionReveal enabled={true} trailingActions={[noopAction]}>
        <div>Row content</div>
      </SwipeActionReveal>,
    );
    expect(html).toContain("translateX(0px)");
  });
});
