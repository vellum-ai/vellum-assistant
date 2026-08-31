/**
 * Tests for `CameraShutter`, the control the voice room and the deep-link
 * capture overlay share.
 *
 * Load-bearing contracts: the design's outer geometry (an 84px ring measured
 * border-in, around a 64px core), which is what makes the shutter the one
 * target on the surface a thumb finds without looking; both capture modes,
 * including the live one the app does not reach; the capture pulse, which is
 * the ONLY thing that distinguishes a taken photo from a dead button, since a
 * viewfinder looks identical either side of a press; and the button surviving a
 * `Tooltip` wrapper, which reaches it through Radix's `asChild` slot rather
 * than rendering its own element.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";

import { Tooltip } from "@vellumai/design-library";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import * as motionReact from "motion/react";

// `useReducedMotion` reads a cached media-query singleton, so a per-test
// `matchMedia` stub can't flip it. Override just that export and drive it
// through this toggle instead.
let reducedMotion = false;
mock.module("motion/react", () => ({
  ...motionReact,
  useReducedMotion: () => reducedMotion,
}));

const { CameraShutter } = await import("@/domains/chat/voice/camera-shutter");

afterEach(() => {
  cleanup();
  reducedMotion = false;
});

const noop = () => {};

const shutter = () => screen.getByTestId("s");
const core = () => screen.getByTestId("camera-shutter-core");
const pulse = () => screen.queryByTestId("camera-shutter-pulse");

describe("CameraShutter", () => {
  test("wears the design's outer geometry, ring measured border-in", () => {
    render(<CameraShutter onClick={noop} ariaLabel="Take photo" testId="s" />);

    // 84 is the OUTER measure: the 2.5px ring eats into it rather than adding
    // to it, so the gap between ring and core is the design's 7.5px.
    expect(shutter().className).toContain("size-[84px]");
    expect(shutter().className).toContain("border-[2.5px]");
    expect(shutter().className).toContain("box-border");
    expect(core().className).toContain("size-16");
  });

  test("photo is white at rest; live is crimson and shrunk", () => {
    const { rerender } = render(
      <CameraShutter onClick={noop} ariaLabel="Take photo" testId="s" />,
    );

    expect(shutter().getAttribute("data-mode")).toBe("photo");
    expect(shutter().className).toContain("border-white");
    expect(core().className).toContain("bg-white");
    expect(core().className).toContain("scale-100");

    // Unreachable in the app (the capture path is photo-only), and part of the
    // component's contract regardless: the core shrinking to a crimson dot is
    // the record-button language, and it belongs to the component rather than
    // to whichever caller reaches it first.
    rerender(
      <CameraShutter
        onClick={noop}
        ariaLabel="Stop live"
        testId="s"
        mode="live"
      />,
    );
    expect(shutter().getAttribute("data-mode")).toBe("live");
    expect(shutter().className).toContain("border-[var(--camera-accent)]");
    expect(core().className).toContain("bg-[var(--camera-accent)]");
    expect(core().className).toContain("scale-[0.58]");
  });

  test("a photo press fires the ring pulse, and fires it again per press", () => {
    render(<CameraShutter onClick={noop} ariaLabel="Take photo" testId="s" />);

    // Nothing at rest: the keyframe starts from a shadow the ring does not
    // otherwise have, so mounting it would announce a photo nobody took.
    expect(pulse()).toBeNull();

    fireEvent.click(shutter());
    const first = pulse();
    expect(first).not.toBeNull();
    expect(first!.className).toContain("camera-shutter-pulse");

    // A remount, not a reused node: a CSS animation cannot be replayed by
    // leaving the element in place, and these presses come as fast as a thumb.
    fireEvent.click(shutter());
    expect(pulse()).not.toBe(first);
  });

  test("live's press stops the stream and does not pulse", () => {
    render(
      <CameraShutter
        onClick={noop}
        ariaLabel="Stop live"
        testId="s"
        mode="live"
      />,
    );

    fireEvent.click(shutter());
    // The ring morphing back to white already reports what happened. A capture
    // pulse would report a frame nobody took.
    expect(pulse()).toBeNull();
  });

  test("capturing dips the core and disabled dims the ring, separately", () => {
    const { rerender } = render(
      <CameraShutter onClick={noop} ariaLabel="Take photo" testId="s" />,
    );

    expect(core().className).not.toContain("opacity-70");
    expect(shutter().className).not.toContain("opacity-60");

    // The overlay disables the shutter before the viewfinder is ready, with
    // nothing being captured yet.
    rerender(
      <CameraShutter
        onClick={noop}
        ariaLabel="Take photo"
        testId="s"
        disabled
      />,
    );
    expect(core().className).not.toContain("opacity-70");
    expect(shutter().className).toContain("opacity-60");

    rerender(
      <CameraShutter
        onClick={noop}
        ariaLabel="Take photo"
        testId="s"
        capturing
        disabled
      />,
    );
    // The ring holds its size while the frame goes: the target under the
    // user's thumb must not move between one shot and the next.
    expect(core().className).toContain("opacity-70");
    expect(core().className).toContain("size-16");
  });

  test("reduced motion retimes the morph without dropping the pulse", () => {
    reducedMotion = true;
    render(<CameraShutter onClick={noop} ariaLabel="Take photo" testId="s" />);

    // The calm class swaps the overshoot for a linear 200ms and shortens the
    // pulse. It does not remove the pulse: that is feedback, not decoration.
    expect(shutter().className).toContain("camera-shutter-calm");
    fireEvent.click(shutter());
    expect(pulse()).not.toBeNull();
  });

  test("still takes the press when a Tooltip wraps it", () => {
    let presses = 0;
    render(
      <Tooltip content="Take photo">
        <CameraShutter
          onClick={() => {
            presses += 1;
          }}
          ariaLabel="Take photo"
          testId="s"
        />
      </Tooltip>,
    );

    const button = shutter();
    expect(button.getAttribute("aria-label")).toBe("Take photo");

    fireEvent.click(button);
    expect(presses).toBe(1);
  });
});
