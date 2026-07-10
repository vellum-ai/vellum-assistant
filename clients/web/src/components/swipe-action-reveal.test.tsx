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
    expect(html).toContain("var(--danger-base)");
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
