import { afterEach, describe, expect, test } from "bun:test";
import { renderHook } from "@testing-library/react";

import {
  TOUCH_MOBILE_MEDIA_QUERY,
  useTouchMobile,
} from "@/hooks/use-touch-mobile";

type MatchMedia = typeof window.matchMedia;

const realMatchMedia = window.matchMedia;

/**
 * Answers `matchMedia` from a set of media features so a test can describe a
 * device (viewport width plus pointer kind) rather than a query string.
 */
function stubMatchMedia({
  narrow,
  coarsePointer,
}: {
  narrow: boolean;
  coarsePointer: boolean;
}): void {
  window.matchMedia = ((query: string) => ({
    matches:
      (!query.includes("max-width: 767px") || narrow) &&
      (!query.includes("pointer: coarse") || coarsePointer),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    onchange: null,
    dispatchEvent: () => false,
  })) as unknown as MatchMedia;
}

afterEach(() => {
  window.matchMedia = realMatchMedia;
});

describe("useTouchMobile", () => {
  test("requires both a narrow viewport and a coarse pointer", () => {
    // The query is the design library's `touch-mobile` variant, so the two
    // features have to be ANDed rather than either one standing alone.
    // https://developer.mozilla.org/en-US/docs/Web/CSS/@media/pointer
    expect(TOUCH_MOBILE_MEDIA_QUERY).toBe(
      "(max-width: 767px) and (pointer: coarse)",
    );
  });

  test("true on a narrow viewport with a coarse pointer (phone)", () => {
    stubMatchMedia({ narrow: true, coarsePointer: true });
    expect(renderHook(() => useTouchMobile()).result.current).toBe(true);
  });

  test("false in a narrow window driven by a mouse (Electron, resized browser)", () => {
    stubMatchMedia({ narrow: true, coarsePointer: false });
    expect(renderHook(() => useTouchMobile()).result.current).toBe(false);
  });

  test("false on a roomy viewport even with a coarse pointer (tablet)", () => {
    stubMatchMedia({ narrow: false, coarsePointer: true });
    expect(renderHook(() => useTouchMobile()).result.current).toBe(false);
  });
});
