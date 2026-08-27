/**
 * Tests for `CameraShutter`, the control the voice room and the deep-link
 * capture overlay share.
 *
 * Load-bearing contracts: the dark fill and dark outer hairline that keep the
 * white ring legible against a frame of any brightness (the voice room pins
 * both classes in its own suite); `capturing` shrinking the inner disc while
 * `disabled` dims the ring, since the two are separate axes at the overlay's
 * call site; and the button surviving a `Tooltip` wrapper, which reaches it
 * through Radix's `asChild` slot rather than rendering its own element.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { Tooltip } from "@vellumai/design-library";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { CameraShutter } from "@/domains/chat/voice/camera-shutter";

afterEach(() => {
  cleanup();
});

const noop = () => {};

describe("CameraShutter", () => {
  test("wears the dark fill and hairline that separate it from the video", () => {
    render(<CameraShutter onClick={noop} ariaLabel="Take photo" testId="s" />);

    const button = screen.getByTestId("s");
    expect(button.className).toContain("bg-black/30");
    expect(button.className).toContain("shadow-");
    expect(button.className).toContain("border-white");
  });

  test("capturing shrinks the disc and disabled dims the ring, separately", () => {
    const { container, rerender } = render(
      <CameraShutter onClick={noop} ariaLabel="Take photo" testId="s" />,
    );

    const disc = () => container.querySelector("span") as HTMLElement;
    expect(disc().className).toContain("size-11");
    expect(screen.getByTestId("s").className).not.toContain("opacity-60");

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
    expect(disc().className).toContain("size-11");
    expect(screen.getByTestId("s").className).toContain("opacity-60");

    rerender(
      <CameraShutter
        onClick={noop}
        ariaLabel="Take photo"
        testId="s"
        capturing
        disabled
      />,
    );
    expect(disc().className).toContain("size-6");
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

    const button = screen.getByTestId("s");
    expect(button.getAttribute("aria-label")).toBe("Take photo");

    fireEvent.click(button);
    expect(presses).toBe(1);
  });
});
