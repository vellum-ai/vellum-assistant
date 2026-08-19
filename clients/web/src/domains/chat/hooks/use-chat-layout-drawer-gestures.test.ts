/**
 * Tests for `useChatLayoutDrawerGestures`, which arbitrates the mobile
 * drawer's two swipe gestures and owns how long the panel stays mounted.
 *
 * The opening gesture is mocked so its `enabled` can be read directly, the
 * pattern `sidebar-shell.test.tsx` established. The closing gesture runs for
 * real, driven through synthesized touch events like
 * `use-swipe-close-drawer.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, renderHook } from "@testing-library/react";

import type { UseEdgeSwipeDrawerArgs } from "@/hooks/use-edge-swipe-drawer";
import { useEdgeSwipeArbiterStore } from "@/stores/edge-swipe-arbiter-store";

let openSwipeArgs: UseEdgeSwipeDrawerArgs | null = null;

mock.module("@/hooks/use-edge-swipe-drawer", () => ({
  useEdgeSwipeDrawer: (args: UseEdgeSwipeDrawerArgs) => {
    openSwipeArgs = args;
  },
}));

const { useChatLayoutDrawerGestures } = await import(
  "./use-chat-layout-drawer-gestures"
);

interface FakeTouch {
  identifier: number;
  clientX: number;
  clientY: number;
}

function makeTouchEvent(
  touches: FakeTouch[],
  changedTouches: FakeTouch[] = [],
): React.TouchEvent {
  return {
    touches: touches as unknown as TouchList,
    changedTouches: changedTouches as unknown as TouchList,
    targetTouches: touches as unknown as TouchList,
    preventDefault: () => {},
    stopPropagation: () => {},
    target: null,
  } as unknown as React.TouchEvent;
}

function coarsePointer(matches: boolean) {
  return ((query: string) => ({
    matches: matches && query.includes("coarse"),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

function renderGestures(onClose: () => void, initialOpen = true) {
  const panel = document.createElement("div");
  document.body.appendChild(panel);
  const panelRef = { current: panel as HTMLElement | null };
  const view = renderHook(
    ({ open }: { open: boolean }) =>
      useChatLayoutDrawerGestures({
        panelRef,
        isMobile: true,
        open,
        onOpen: () => {},
        onClose,
      }),
    { initialProps: { open: initialOpen } },
  );
  return { ...view, panel };
}

/** Drag the panel `dx` px and release, the way a finger would. */
function swipe(
  result: { current: ReturnType<typeof useChatLayoutDrawerGestures> },
  dx: number,
) {
  const start = { identifier: 1, clientX: 300, clientY: 400 };
  const end = { identifier: 1, clientX: 300 + dx, clientY: 400 };
  act(() => {
    result.current.onTouchStart(makeTouchEvent([start]));
  });
  act(() => {
    result.current.onTouchMove(makeTouchEvent([end]));
  });
  act(() => {
    result.current.onTouchEnd(makeTouchEvent([], [end]));
  });
}

beforeEach(() => {
  window.matchMedia = coarsePointer(true);
  useEdgeSwipeArbiterStore.setState({ backOwnerCount: 0, openRowCount: 0 });
});

afterEach(() => {
  window.matchMedia = coarsePointer(false);
  useEdgeSwipeArbiterStore.setState({ backOwnerCount: 0, openRowCount: 0 });
  openSwipeArgs = null;
  document.body.replaceChildren();
});

describe("revealed-row arbitration", () => {
  test("disarms the opening swipe, which listens across the whole route", () => {
    // GIVEN a drawer that is closed
    renderGestures(() => {}, false);
    expect(openSwipeArgs?.enabled).toBe(true);

    // WHEN a row is revealed somewhere on the route behind it
    act(() => {
      useEdgeSwipeArbiterStore.getState().registerOpenRow();
    });

    // THEN the left-edge swipe stands down: it listens on `document`, so it
    // would otherwise steal the swipe that closes the revealed row.
    expect(openSwipeArgs?.enabled).toBe(false);
  });

  test("leaves the closing swipe armed, which only sees its own panel", () => {
    // GIVEN an open drawer with a row revealed on the route behind it, e.g. a
    // library card left showing its actions before the drawer was opened
    const onClose = mock(() => {});
    const { result } = renderGestures(onClose);
    act(() => {
      useEdgeSwipeArbiterStore.getState().registerOpenRow();
    });

    // WHEN a leftward swipe lands on the drawer itself
    swipe(result, -120);

    // THEN it still closes: a row revealed behind the drawer says nothing
    // about a touch that landed on the drawer. Rows inside it are handled at
    // the target instead, by `useSwipeCloseDrawer`'s own marker check.
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("presence", () => {
  test("mounts the panel for an opening drag before it commits", () => {
    // GIVEN a closed drawer
    const { result } = renderGestures(() => {}, false);
    expect(result.current.present).toBe(false);

    // WHEN a left-edge swipe starts tracking it in
    act(() => {
      openSwipeArgs?.onDragStart();
    });

    // THEN the panel mounts so the drag has something to move
    expect(result.current.present).toBe(true);

    // AND a swipe that never commits takes it back out
    act(() => {
      openSwipeArgs?.onSettle();
    });
    expect(result.current.present).toBe(false);
  });
});
