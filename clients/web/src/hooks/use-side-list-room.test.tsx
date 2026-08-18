/**
 * Tests for `useSideListRoom`, the one owner of a list-detail pane's choice
 * between an inline list column and the drawer that stands in for it.
 *
 * The shape worth pinning is that the answer follows the *pane*. These pages
 * render inside the chat layout's content area, so the window is several
 * hundred pixels wider than the box the list has to fit into, and a decision
 * taken on the window is the bug this hook exists to prevent.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { act, render, screen } from "@testing-library/react";

import { useSideListRoom } from "@/hooks/use-side-list-room";

const originalGetBoundingClientRect = Element.prototype.getBoundingClientRect;

/**
 * Make every measured element report `width`. happy-dom has no layout engine,
 * so a real box has to be stubbed; its `ResizeObserver` is a no-op stub too,
 * which is why the harness below remounts the pane to force a re-measure.
 */
function stubPaneWidth(width: number): void {
  Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
    return { ...new DOMRect(0, 0, width, 600), width, height: 600 } as DOMRect;
  };
}

afterEach(() => {
  Element.prototype.getBoundingClientRect = originalGetBoundingClientRect;
});

function Harness({ paneKey }: { paneKey: string }) {
  const { paneRef, hasRoomForList, drawerOpen, openDrawer } = useSideListRoom();
  return (
    <>
      {/* Keyed so a width change remounts the element and `useElementSize`
          measures again, standing in for the ResizeObserver happy-dom lacks. */}
      <div key={paneKey} ref={paneRef} />
      <span data-testid="room">{String(hasRoomForList)}</span>
      <span data-testid="drawer">{String(drawerOpen)}</span>
      <button type="button" onClick={openDrawer}>
        open
      </button>
    </>
  );
}

function room(): string {
  return screen.getByTestId("room").textContent ?? "";
}

describe("useSideListRoom", () => {
  test("a pane too narrow for both columns has no room, in a wide window", () => {
    // The window the app actually runs in stays wide throughout: 1024px is
    // happy-dom's default and comfortably over the threshold. Only the pane is
    // narrow, which is exactly the combination a viewport media query gets
    // wrong. 470px is the pane at a 768px window with the sidebar expanded.
    expect(window.innerWidth).toBeGreaterThan(640);
    stubPaneWidth(470);
    render(<Harness paneKey="narrow" />);
    expect(room()).toBe("false");
  });

  test("a pane wide enough for both columns has room", () => {
    stubPaneWidth(970);
    render(<Harness paneKey="wide" />);
    expect(room()).toBe("true");
  });

  test("an unmeasured pane falls back to the window rather than reading as zero", () => {
    // A subtree with no layout reports a zero box. Treating that as "no room"
    // would show the drawer on a full-width desktop pane for as long as the
    // measurement is missing.
    stubPaneWidth(0);
    render(<Harness paneKey="unmeasured" />);
    expect(room()).toBe("true");
  });

  test("the drawer does not survive the pane growing back", () => {
    // The trigger is gone once the list is inline, so a drawer left open would
    // reappear unprompted the next time the pane narrows, with nothing on
    // screen having asked for it.
    stubPaneWidth(470);
    const view = render(<Harness paneKey="narrow" />);
    act(() => {
      screen.getByRole("button", { name: "open" }).click();
    });
    expect(screen.getByTestId("drawer").textContent).toBe("true");

    stubPaneWidth(970);
    view.rerender(<Harness paneKey="wide" />);
    expect(room()).toBe("true");
    expect(screen.getByTestId("drawer").textContent).toBe("false");

    stubPaneWidth(470);
    view.rerender(<Harness paneKey="narrow-again" />);
    expect(room()).toBe("false");
    expect(screen.getByTestId("drawer").textContent).toBe("false");
  });
});
