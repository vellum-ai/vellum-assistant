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
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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

/** The body outline is the single <path> in the first <g> of the avatar SVG. */
function bodyPath(container: HTMLElement): SVGPathElement {
  return container.querySelector("svg > g path") as SVGPathElement;
}

let timeoutCallbacks: Array<() => void>;
let intervalCallbacks: Array<() => void>;
let realSetTimeout: typeof globalThis.setTimeout;
let realSetInterval: typeof globalThis.setInterval;

beforeEach(() => {
  timeoutCallbacks = [];
  intervalCallbacks = [];
  realSetTimeout = globalThis.setTimeout;
  realSetInterval = globalThis.setInterval;
  // Capture scheduled callbacks instead of running them on a real clock.
  globalThis.setTimeout = ((fn: () => void) => {
    timeoutCallbacks.push(fn);
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof globalThis.setTimeout;
  globalThis.setInterval = ((fn: () => void) => {
    intervalCallbacks.push(fn);
    return 0 as unknown as ReturnType<typeof setInterval>;
  }) as typeof globalThis.setInterval;
});

afterEach(() => {
  globalThis.setTimeout = realSetTimeout;
  globalThis.setInterval = realSetInterval;
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

describe("AnimatedAvatar canvas", () => {
  test("lets the body draw outside the SVG box while it moves", () => {
    const { container } = render(
      <AnimatedAvatar
        components={BUNDLED_COMPONENTS}
        traits={TRAITS}
        size={240}
        isAssistantBusy
      />,
    );

    const svg = container.querySelector("svg") as SVGSVGElement;
    expect(svg.style.overflow).toBe("visible");
  });
});

describe("AnimatedAvatar streaming morph", () => {
  test("cycles the body path without a React state update", () => {
    const { container } = render(
      <AnimatedAvatar
        components={BUNDLED_COMPONENTS}
        traits={TRAITS}
        size={56}
        isAssistantBusy
      />,
    );

    const restingPath = bodyPath(container).getAttribute("d");
    expect(restingPath).toBeTruthy();

    // Deliberately NOT wrapped in `act()`. The morph is a direct attribute
    // write, so the DOM must change with no commit to flush — a `setState`
    // here would not be applied outside `act()`, which is the regression this
    // guards (a 6.7Hz React update per busy avatar for the whole turn).
    intervalCallbacks[0]?.();

    expect(bodyPath(container).getAttribute("d")).not.toBe(restingPath);
  });

  test("settles back to the resting shape when the turn ends", () => {
    const { container, rerender } = render(
      <AnimatedAvatar
        components={BUNDLED_COMPONENTS}
        traits={TRAITS}
        size={56}
        isAssistantBusy
      />,
    );

    const restingPath = bodyPath(container).getAttribute("d");
    intervalCallbacks[0]?.();
    expect(bodyPath(container).getAttribute("d")).not.toBe(restingPath);

    rerender(
      <AnimatedAvatar
        components={BUNDLED_COMPONENTS}
        traits={TRAITS}
        size={56}
        isAssistantBusy={false}
      />,
    );

    // Without the cleanup write the body would stay frozen on whichever
    // wobbled variant the cycle happened to land on.
    expect(bodyPath(container).getAttribute("d")).toBe(restingPath);
  });

  test("stays still while streaming is not active", () => {
    render(
      <AnimatedAvatar
        components={BUNDLED_COMPONENTS}
        traits={TRAITS}
        size={56}
        isAssistantBusy={false}
      />,
    );

    expect(intervalCallbacks).toHaveLength(0);
  });
});
