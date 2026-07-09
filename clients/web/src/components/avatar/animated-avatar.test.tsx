/**
 * Regression test for the "stuck blink" bug: a blink is a
 * `setIsBlinking(true)` → 150ms → `false` pair, and if `isAssistantBusy` flips
 * true mid-blink the effect cleanup cancels the pending "un-blink" timeout.
 * Without the streaming guard the eyes freeze squished (scaleY 0.1) until the
 * component remounts (page refresh / conversation switch).
 *
 * bun:test has no fake-timer API, so we capture the callback the blink effect
 * registers via setTimeout and invoke it from `act()` — same approach as
 * website-carousel.test.tsx.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { act } from "react";
import { cleanup, render } from "@testing-library/react";

import { AnimatedAvatar } from "@/components/avatar/animated-avatar";
import { BUNDLED_COMPONENTS } from "@/utils/avatar-bundled-components";

const TRAITS = { bodyShape: "sprout", eyeStyle: "grumpy", color: "green" };

/** The eyes live in the second <g> of the avatar SVG (body is the first). */
function eyeTransform(container: HTMLElement): string {
  const groups = container.querySelectorAll("svg > g");
  return (groups[1] as SVGGElement).style.transform;
}

let timeoutCallbacks: Array<() => void>;
let realSetTimeout: typeof globalThis.setTimeout;

beforeEach(() => {
  timeoutCallbacks = [];
  realSetTimeout = globalThis.setTimeout;
  // Capture scheduled callbacks instead of running them on a real clock.
  globalThis.setTimeout = ((fn: () => void) => {
    timeoutCallbacks.push(fn);
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof globalThis.setTimeout;
});

afterEach(() => {
  globalThis.setTimeout = realSetTimeout;
  cleanup();
});

describe("AnimatedAvatar blink", () => {
  test("a blink interrupted by streaming does not leave the eyes squished", () => {
    const { container, rerender } = render(
      <AnimatedAvatar
        components={BUNDLED_COMPONENTS}
        traits={TRAITS}
        size={56}
        isAssistantBusy={false}
      />,
    );

    // Eyes open by default.
    expect(eyeTransform(container)).toBe("scaleY(1)");

    // Fire the scheduled blink → setIsBlinking(true): eyes squish.
    act(() => {
      timeoutCallbacks[0]?.();
    });
    expect(eyeTransform(container)).toBe("scaleY(0.1)");

    // Streaming begins mid-blink. Before the fix this froze the eyes squished
    // until a remount; now the eyes return to open.
    rerender(
      <AnimatedAvatar
        components={BUNDLED_COMPONENTS}
        traits={TRAITS}
        size={56}
        isAssistantBusy
      />,
    );
    expect(eyeTransform(container)).toBe("scaleY(1)");
  });
});
