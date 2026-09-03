import { describe, expect, test } from "bun:test";
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

/**
 * The px a layer is translated by, read from the layer holding the action
 * named `label`. Parsed rather than string-matched so the assertion is about
 * the distance travelled, and survives the transform being written as
 * `translate3d` or with different spacing.
 */
function shiftOf(host: HTMLElement, label: string): number {
  const layer = host.querySelector(
    `button[aria-label="${label}"]`,
  )?.parentElement;
  const match = /translate(?:X|3d)?\(\s*(-?[\d.]+)px/.exec(
    layer?.style.transform ?? "",
  );
  if (!match) {
    throw new Error(`no translate on the layer holding "${label}"`);
  }
  return Number(match[1]);
}

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

  test("each action layer sits a full width outside the clip at rest", () => {
    const html = renderToStaticMarkup(
      <SwipeActionReveal
        enabled={true}
        leadingActions={[{ ...noopAction, id: "pin", label: "Pin" }]}
        trailingActions={[{ ...noopAction, id: "archive", label: "Archive" }]}
      >
        <div>Row content</div>
      </SwipeActionReveal>,
    );

    // What hides an unrevealed action is the clip, not anything painted over
    // it: each layer is translated its own width off the edge it hangs from,
    // so at rest it is wholly outside the box that clips. A swipe walks that
    // back in step with the content, which is what confines an action to the
    // strip the content has vacated.
    //
    // Each side is asserted against the edge it hangs from, and the layers are
    // found by the action each one holds. Asserting that the two shifts exist
    // somewhere would pass just as well with the sides swapped, which is a row
    // whose actions slide in from the wrong edge.
    const host = document.createElement("div");
    host.innerHTML = html;

    expect(shiftOf(host, "Pin")).toBe(-ACTION_WIDTH_PX);
    expect(shiftOf(host, "Archive")).toBe(ACTION_WIDTH_PX);
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

  test("only the actions are clipped, never the root or the content", () => {
    const html = renderToStaticMarkup(
      <SwipeActionReveal enabled={true} trailingActions={[noopAction]}>
        <div data-testid="content">Row content</div>
      </SwipeActionReveal>,
    );

    // A flex or grid item whose overflow is not `visible` has its automatic
    // minimum size resolved to zero rather than to its content, so a container
    // that is out of room squashes it away entirely. The root is what a list
    // lays out, so it must not clip.
    //
    // Nor may anything between the root and the content: a clip there cuts a
    // row at its own edge as it slides, which for a `w-fit` pill is the middle
    // of the open rail beside it. The surface that has an edge (a card) is what
    // clips at that edge. The action clip is the one clip, and it holds only
    // the action layers.
    const host = document.createElement("div");
    host.innerHTML = html;
    const root = host.firstElementChild!;
    expect(root.hasAttribute("data-swipe-action-row")).toBe(true);

    const actionClip = host.querySelector('button[aria-label="Test"]')!
      .parentElement!.parentElement!;
    expect(actionClip.className).toContain("overflow-hidden");

    let node = host.querySelector('[data-testid="content"]')!.parentElement;
    while (node && node !== root.parentElement) {
      expect(node.className).not.toContain("overflow-hidden");
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
