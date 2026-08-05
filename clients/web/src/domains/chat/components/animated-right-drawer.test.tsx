/**
 * `AnimatedRightDrawer` adjusts its `mounted` / `retainedRight` state during
 * render (guarded render-phase setState) rather than in effects keyed on the
 * `open` / `right` props. `right` is a fresh element on every parent render,
 * so a prop-keyed effect would fire a setState in every commit's passive
 * phase while the drawer is open, and enough such commits back to back trip
 * React's nested-update limit under streaming load (error 185, LUM-3062).
 * See `lib/commit-pressure.ts`.
 *
 * The Profiler test pins that invariant directly: one parent render of an
 * open drawer produces exactly one commit, with no cascaded effect commit.
 * The remaining tests pin the behavior the state adjustments exist for
 * (synchronous mount on open, content retention through the close wipe).
 *
 * `motion/react` is mocked with plain elements; the close animation's
 * `onAnimationComplete` is captured and fired manually so retention during
 * the close wipe is observable (see chat-route-content.test for the shared
 * mock pattern).
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import {
  act,
  createElement,
  Profiler,
  type ReactElement,
  type ReactNode,
} from "react";

// --- Mocks ----------------------------------------------------------------

/** Props consumed by motion itself; everything else passes through to the DOM. */
const MOTION_ONLY_PROPS = new Set([
  "initial",
  "animate",
  "exit",
  "transition",
  "variants",
  "whileHover",
  "whileTap",
  "layout",
  "layoutId",
  "custom",
  "onAnimationStart",
  "onAnimationComplete",
]);

/**
 * Latest `onAnimationComplete` handed to the motion stub. Unlike the shared
 * mock in chat-route-content.test, the stub never fires it on its own; tests
 * invoke it to simulate the width animation finishing.
 */
let completeAnimation: (() => void) | undefined;

mock.module("motion/react", () => ({
  motion: new Proxy(
    {} as Record<string, (props: Record<string, unknown>) => ReactElement>,
    {
      get: (_target, tag) => (props: Record<string, unknown>) => {
        completeAnimation = props.onAnimationComplete as
          | (() => void)
          | undefined;
        const domProps: Record<string, unknown> = {};
        for (const key in props) {
          if (!MOTION_ONLY_PROPS.has(key)) {
            domProps[key] = props[key];
          }
        }
        return createElement(String(tag), domProps);
      },
    },
  ),
  useReducedMotion: () => false,
}));

import { AnimatedRightDrawer } from "@/domains/chat/components/animated-right-drawer";

// --- Tests ----------------------------------------------------------------

function drawer({
  open,
  right,
  onCommit,
}: {
  open: boolean;
  right: ReactNode;
  onCommit?: () => void;
}) {
  const tree = (
    <AnimatedRightDrawer open={open} left={<div>chat</div>} right={right} />
  );
  if (!onCommit) {
    return tree;
  }
  return (
    <Profiler id="animated-right-drawer" onRender={onCommit}>
      {tree}
    </Profiler>
  );
}

describe("AnimatedRightDrawer", () => {
  afterEach(() => {
    cleanup();
    completeAnimation = undefined;
  });

  test("re-rendering an open drawer with a fresh right element commits exactly once per render", () => {
    // The failure shape behind LUM-3062: prop-keyed effects turn every parent
    // render of an open drawer into TWO commits (the render itself, then the
    // passive-effect setState). Count commits via Profiler and require the
    // 1:1 ratio; an effect-based `retainedRight`/`mounted` adjustment doubles
    // the count and fails this.
    let commits = 0;
    const onCommit = () => {
      commits += 1;
    };
    const { rerender } = render(
      drawer({ open: true, right: <div>panel v1</div>, onCommit }),
    );
    const afterMount = commits;

    const parentRenders = 3;
    for (let i = 0; i < parentRenders; i += 1) {
      // A fresh element each time, exactly like a re-rendering parent.
      rerender(
        drawer({ open: true, right: <div>panel v{2 + i}</div>, onCommit }),
      );
    }
    expect(commits - afterMount).toBe(parentRenders);
  });

  test("opening mounts the drawer content in the same render pass", () => {
    const { rerender } = render(drawer({ open: false, right: null }));
    expect(screen.queryByText("panel")).toBeNull();

    rerender(drawer({ open: true, right: <div>panel</div> }));
    expect(screen.getByText("panel")).toBeTruthy();
  });

  test("closing retains the last content through the wipe and unmounts once the animation completes", () => {
    const { rerender } = render(
      drawer({ open: true, right: <div>panel</div> }),
    );
    expect(screen.getByText("panel")).toBeTruthy();

    // Close: `right` goes null in the same render, as in both production
    // call sites. The retained copy must keep the content visible.
    rerender(drawer({ open: false, right: null }));
    expect(screen.getByText("panel")).toBeTruthy();

    // Width animation reaches 0: content and drag handle tear down.
    act(() => {
      completeAnimation?.();
    });
    expect(screen.queryByText("panel")).toBeNull();
    expect(screen.queryByRole("separator")).toBeNull();
  });
});
