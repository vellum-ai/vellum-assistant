/**
 * Tests for `useShowsHoverAffordance`.
 *
 * Driven through `matchMedia` rather than by mocking the hook's own module, so
 * the assertions turn on the media feature the CSS reveal rules read too.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";

import { useShowsHoverAffordance } from "@/hooks/use-hover-affordance";
import { viewportAxesStub } from "@/hooks/viewport-axes.test-helper";

const viewport = viewportAxesStub();

function shows(hasTouchPath: boolean): boolean {
  let result: boolean | null = null;

  function Probe() {
    result = useShowsHoverAffordance(hasTouchPath);
    return null;
  }

  render(<Probe />);

  return result!;
}

afterEach(() => {
  cleanup();
  viewport.restore();
});

describe("useShowsHoverAffordance", () => {
  test("a hover-capable device keeps the affordance either way", () => {
    viewport.set({ narrow: false, coarsePointer: false });

    expect(shows(true)).toBe(true);
    expect(shows(false)).toBe(true);
  });

  test("a device with no hover keeps an affordance nothing else reaches", () => {
    viewport.set({ narrow: true, coarsePointer: true });

    expect(shows(false)).toBe(true);
  });

  test("a device with no hover drops an affordance a gesture also reaches", () => {
    viewport.set({ narrow: true, coarsePointer: true });

    expect(shows(true)).toBe(false);
  });

  /* Window size is not the question: a desktop window narrowed past the mobile
     breakpoint still has a mouse and no gestures, so dropping the affordance
     there would leave the command reachable by nothing. */
  test("a narrow window driven by a mouse keeps the affordance", () => {
    viewport.set({ narrow: true, coarsePointer: false });

    expect(shows(true)).toBe(true);
  });

  /* And the converse: a roomy tablet cannot hover, whatever its width. */
  test("a roomy touch tablet drops it", () => {
    viewport.set({ narrow: false, coarsePointer: true });

    expect(shows(true)).toBe(false);
  });
});
