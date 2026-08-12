import { afterEach, describe, expect, test } from "bun:test";
import { renderHook } from "@testing-library/react";

import {
  TOUCH_MOBILE_MEDIA_QUERY,
  useTouchMobile,
} from "@/hooks/use-touch-mobile";
import { stubViewportAxes } from "@/hooks/viewport-axes.test-helper";

let restoreMatchMedia: (() => void) | undefined;

function stubDevice(axes: { narrow: boolean; coarsePointer: boolean }): void {
  restoreMatchMedia = stubViewportAxes(axes);
}

afterEach(() => {
  restoreMatchMedia?.();
  restoreMatchMedia = undefined;
});

describe("useTouchMobile", () => {
  test("requires both a narrow viewport and a coarse pointer", () => {
    // The query is the design library's `touch-mobile` variant, character for
    // character, so the two features are ANDed rather than either one standing
    // alone, and the width half is written in range syntax as the variant is.
    // https://developer.mozilla.org/en-US/docs/Web/CSS/@media/pointer
    // https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_media_queries/Using_media_queries#syntax_improvements_in_level_4
    expect(TOUCH_MOBILE_MEDIA_QUERY).toBe(
      "(width < 48rem) and (pointer: coarse)",
    );
  });

  test("true on a narrow viewport with a coarse pointer (phone)", () => {
    stubDevice({ narrow: true, coarsePointer: true });
    expect(renderHook(() => useTouchMobile()).result.current).toBe(true);
  });

  test("false in a narrow window driven by a mouse (Electron, resized browser)", () => {
    stubDevice({ narrow: true, coarsePointer: false });
    expect(renderHook(() => useTouchMobile()).result.current).toBe(false);
  });

  test("false on a roomy viewport even with a coarse pointer (tablet)", () => {
    stubDevice({ narrow: false, coarsePointer: true });
    expect(renderHook(() => useTouchMobile()).result.current).toBe(false);
  });
});
