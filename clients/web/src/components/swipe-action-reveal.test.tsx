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
        leadingActions={[noopAction]}
        trailingActions={[noopAction]}
      >
        <div>Row content</div>
      </SwipeActionReveal>,
    );

    // What hides an unrevealed action is the clip, not anything painted over
    // it: each layer is translated its own width off the edge it hangs from,
    // so at rest it is wholly outside the box that clips. A swipe walks that
    // back in step with the content, which is what confines an action to the
    // strip the content has vacated.
    const host = document.createElement("div");
    host.innerHTML = html;
    const layers = [
      ...host.querySelectorAll<HTMLElement>("[style*=translateX]"),
    ];
    const shifts = layers.map((layer) => layer.style.transform);

    expect(shifts).toContain(`translateX(${ACTION_WIDTH_PX}px)`);
    expect(shifts).toContain(`translateX(-${ACTION_WIDTH_PX}px)`);
  });

  test("the content layer paints no fill of its own", () => {
    const html = renderToStaticMarkup(
      <SwipeActionReveal enabled={true} trailingActions={[noopAction]}>
        <div>Row content</div>
      </SwipeActionReveal>,
    );

    // A fill here would be the row's full width whatever shape the row is,
    // which is what banded the sidebar's `w-fit` pills (LUM-3147). Nothing
    // needs covering now, so nothing is painted, and a host no longer has to
    // name the surface its rows rest on for the wrapper to match.
    expect(html).not.toContain("--swipe-reveal-bg");
    expect(html).not.toContain("--surface-overlay");
  });

  test("the row a list lays out is not the element that clips", () => {
    const html = renderToStaticMarkup(
      <SwipeActionReveal enabled={true} trailingActions={[noopAction]}>
        <div>Row content</div>
      </SwipeActionReveal>,
    );

    // A flex or grid item whose overflow is not `visible` has its automatic
    // minimum size resolved to zero rather than to its content, so a container
    // that is out of room squashes it away entirely: to a border in a capped
    // column, to nothing at all in a row. The root is what a list lays out, so
    // the clip that hides the action layers has to sit inside it.
    const host = document.createElement("div");
    host.innerHTML = html;
    const root = host.firstElementChild;

    expect(root?.hasAttribute("data-swipe-action-row")).toBe(true);
    expect(root?.className).not.toContain("overflow-hidden");
    expect(root?.firstElementChild?.className).toContain("overflow-hidden");
  });

  test("keeps its mark when a parent hands the row a slot name", () => {
    // What `ContextMenu.Trigger` does with `asChild`, which is how the
    // pinned-app pill mounts: it clones the row and passes its own props down.
    // While the mark shared the `data-slot` channel the injected name replaced
    // it, so the drawer's swipe-to-close never saw a row to stand down for and
    // fought the pill for every horizontal drag.
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
