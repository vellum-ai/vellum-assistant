/**
 * Drag mechanics for the Pinned section's resize handle.
 *
 * happy-dom implements pointer capture but not layout, so every rect height
 * reads 0: the expected values below are pure clamp math from a 0px start.
 * Real divider tracking is covered by manual QA, matching the side-menu
 * width handle.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { createRef, type RefObject } from "react";

import {
  SIDEBAR_SECTION_RESIZE_MAX_HEIGHT,
  SIDEBAR_SECTION_RESIZE_MIN_HEIGHT,
} from "@/components/sidebar-nav-geometry";
import { SidebarSectionResizeHandle } from "@/domains/chat/components/sidebar-section-resize-handle";

afterEach(() => {
  cleanup();
  document.body.style.cursor = "";
  document.body.style.userSelect = "";
});

function Harness({
  targetRef,
  withTarget,
  resizable,
  onCommit,
  onReset,
}: {
  targetRef: RefObject<HTMLDivElement | null>;
  withTarget: boolean;
  resizable: boolean;
  onCommit: (height: number) => void;
  onReset?: () => void;
}) {
  return (
    <>
      {withTarget ? <div data-testid="target" ref={targetRef} /> : null}
      <SidebarSectionResizeHandle
        targetRef={targetRef}
        resizable={resizable}
        onCommit={onCommit}
        onReset={onReset}
      />
    </>
  );
}

function renderHandle({ resizable = true }: { resizable?: boolean } = {}) {
  const targetRef = createRef<HTMLDivElement>();
  const onCommit = mock((_height: number) => {});
  const onReset = mock(() => {});
  const utils = render(
    <Harness
      targetRef={targetRef}
      withTarget
      resizable={resizable}
      onCommit={onCommit}
      onReset={onReset}
    />,
  );
  const root = utils.container.querySelector<HTMLElement>(
    '[data-slot="sidebar-section-resize-handle"]',
  );
  if (!root || !(root.firstElementChild instanceof HTMLElement)) {
    throw new Error("expected the resize handle and its hit strip");
  }
  return {
    ...utils,
    targetRef,
    onCommit,
    onReset,
    root,
    hit: root.firstElementChild,
  };
}

// The rect height reads 0, so the clamped drag-start height is the minimum.
const START_HEIGHT = SIDEBAR_SECTION_RESIZE_MIN_HEIGHT;

describe("SidebarSectionResizeHandle", () => {
  test("drags the divider and commits the released height", () => {
    const { hit, targetRef, onCommit } = renderHandle();

    fireEvent.pointerDown(hit, { button: 0, pointerId: 1, clientY: 100 });
    expect(document.body.style.cursor).toBe("row-resize");
    expect(document.body.style.userSelect).toBe("none");

    fireEvent.pointerMove(hit, { pointerId: 1, clientY: 400 });
    expect(targetRef.current?.style.maxHeight).toBe("300px");

    fireEvent.pointerUp(hit, { pointerId: 1, clientY: 400 });
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(300);
    expect(document.body.style.cursor).toBe("");
    expect(document.body.style.userSelect).toBe("");
  });

  test("clamps the drag to the resize bounds", () => {
    const { hit, targetRef, onCommit } = renderHandle();

    fireEvent.pointerDown(hit, { button: 0, pointerId: 1, clientY: 0 });
    fireEvent.pointerMove(hit, { pointerId: 1, clientY: 1000 });
    expect(targetRef.current?.style.maxHeight).toBe(
      `${SIDEBAR_SECTION_RESIZE_MAX_HEIGHT}px`,
    );

    fireEvent.pointerMove(hit, { pointerId: 1, clientY: -500 });
    expect(targetRef.current?.style.maxHeight).toBe(
      `${SIDEBAR_SECTION_RESIZE_MIN_HEIGHT}px`,
    );

    // The commit carries the clamped value, not the raw pointer math.
    fireEvent.pointerMove(hit, { pointerId: 1, clientY: 1000 });
    fireEvent.pointerUp(hit, { pointerId: 1, clientY: 1000 });
    expect(onCommit).toHaveBeenCalledWith(SIDEBAR_SECTION_RESIZE_MAX_HEIGHT);
  });

  // With a persisted height taller than the rendered content, a stray tap
  // must not silently re-cap the section to its rendered height.
  test("a press that never moves commits nothing", () => {
    const { hit, onCommit } = renderHandle();

    fireEvent.pointerDown(hit, { button: 0, pointerId: 1, clientY: 100 });
    fireEvent.pointerUp(hit, { pointerId: 1, clientY: 100 });

    expect(onCommit).not.toHaveBeenCalled();
    expect(document.body.style.cursor).toBe("");
  });

  // A move that lands back on the clamped start height also changes nothing.
  test("a drag that returns to its start commits nothing", () => {
    const { hit, targetRef, onCommit } = renderHandle();

    fireEvent.pointerDown(hit, { button: 0, pointerId: 1, clientY: 100 });
    fireEvent.pointerMove(hit, { pointerId: 1, clientY: 400 });
    fireEvent.pointerMove(hit, {
      pointerId: 1,
      clientY: 100 + START_HEIGHT,
    });
    expect(targetRef.current?.style.maxHeight).toBe(`${START_HEIGHT}px`);

    fireEvent.pointerUp(hit, { pointerId: 1, clientY: 100 + START_HEIGHT });
    expect(onCommit).not.toHaveBeenCalled();
  });

  test("inert when not resizable", () => {
    const { hit, root, targetRef, onCommit } = renderHandle({
      resizable: false,
    });

    expect(root.hasAttribute("data-resizable")).toBe(false);

    fireEvent.pointerDown(hit, { button: 0, pointerId: 1, clientY: 100 });
    fireEvent.pointerMove(hit, { pointerId: 1, clientY: 400 });
    fireEvent.pointerUp(hit, { pointerId: 1, clientY: 400 });

    expect(document.body.style.cursor).toBe("");
    expect(targetRef.current?.style.maxHeight).toBe("");
    expect(onCommit).not.toHaveBeenCalled();
  });

  test("keeps its footing when the target unmounts mid-drag", () => {
    const { hit, targetRef, onCommit, onReset, rerender } = renderHandle();

    fireEvent.pointerDown(hit, { button: 0, pointerId: 1, clientY: 100 });
    fireEvent.pointerMove(hit, { pointerId: 1, clientY: 400 });

    // The section collapses (or the last pin vanishes) under the pointer.
    rerender(
      <Harness
        targetRef={targetRef}
        withTarget={false}
        resizable={false}
        onCommit={onCommit}
        onReset={onReset}
      />,
    );
    expect(targetRef.current).toBeNull();

    fireEvent.pointerMove(hit, { pointerId: 1, clientY: 500 });
    fireEvent.pointerUp(hit, { pointerId: 1, clientY: 500 });

    expect(document.body.style.cursor).toBe("");
    expect(document.body.style.userSelect).toBe("");
    expect(onCommit).toHaveBeenCalledWith(400);
  });

  test("pointercancel ends the drag like pointerup", () => {
    const { hit, onCommit } = renderHandle();

    fireEvent.pointerDown(hit, { button: 0, pointerId: 1, clientY: 100 });
    fireEvent.pointerMove(hit, { pointerId: 1, clientY: 400 });
    // The cancel coordinate is deliberately garbage: the commit must come
    // from the last tracked move, not from this event.
    fireEvent.pointerCancel(hit, { pointerId: 1, clientY: -9999 });

    expect(onCommit).toHaveBeenCalledWith(300);
    expect(document.body.style.cursor).toBe("");
  });

  test("double-click resets only while resizable", () => {
    const active = renderHandle();
    fireEvent.doubleClick(active.hit);
    expect(active.onReset).toHaveBeenCalledTimes(1);
    cleanup();

    const inert = renderHandle({ resizable: false });
    fireEvent.doubleClick(inert.hit);
    expect(inert.onReset).not.toHaveBeenCalled();
  });
});
