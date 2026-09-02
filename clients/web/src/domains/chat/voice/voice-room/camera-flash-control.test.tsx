/**
 * The flash button: one press, three states, in a fixed order.
 *
 * The order is the whole contract. `off` is where the control rests and where a
 * press from `on` has to land, or the user can reach `auto` and `on` but never
 * get back to a camera that will not fire.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import type { FlashMode } from "@/stores/voice-prefs-store";

import { CameraFlashControl, nextFlashMode } from "./camera-flash-control";

afterEach(() => {
  cleanup();
});

describe("nextFlashMode", () => {
  test("cycles off, auto, on, and back to off", () => {
    expect(nextFlashMode("off")).toBe("auto");
    expect(nextFlashMode("auto")).toBe("on");
    expect(nextFlashMode("on")).toBe("off");
  });

  test("returns to where it started in three presses", () => {
    const modes: FlashMode[] = ["off", "auto", "on"];
    for (const start of modes) {
      expect(nextFlashMode(nextFlashMode(nextFlashMode(start)))).toBe(start);
    }
  });
});

describe("CameraFlashControl", () => {
  test("presses through to the caller", () => {
    const onClick = mock(() => {});
    render(
      <CameraFlashControl
        mode="off"
        ariaLabel="Flash off"
        autoBadge="A"
        onClick={onClick}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Flash off" }));

    expect(onClick).toHaveBeenCalledTimes(1);
  });

  test("carries its state for assistive tech and for the test seam", () => {
    const { rerender } = render(
      <CameraFlashControl
        mode="auto"
        ariaLabel="Flash auto"
        autoBadge="A"
        onClick={() => {}}
        testId="flash"
      />,
    );

    expect(screen.getByTestId("flash").dataset.flashMode).toBe("auto");
    expect(screen.getByRole("button", { name: "Flash auto" })).not.toBeNull();

    rerender(
      <CameraFlashControl
        mode="on"
        ariaLabel="Flash on"
        autoBadge="A"
        onClick={() => {}}
        testId="flash"
      />,
    );

    expect(screen.getByTestId("flash").dataset.flashMode).toBe("on");
  });

  test("slashes the bolt only while the flash is off", () => {
    const paths = (mode: FlashMode) => {
      cleanup();
      render(
        <CameraFlashControl
          mode={mode}
          ariaLabel="Flash"
          autoBadge="A"
          onClick={() => {}}
          testId="flash"
        />,
      );
      return screen.getByTestId("flash").querySelectorAll("path").length;
    };

    // The slash is the second path. Nothing else in the glyph varies, so the
    // count is what tells "will not fire" from "will".
    expect(paths("off")).toBe(2);
    expect(paths("auto")).toBe(1);
    expect(paths("on")).toBe(1);
  });

  test("badges auto, and only auto", () => {
    const badge = (mode: FlashMode) => {
      cleanup();
      render(
        <CameraFlashControl
          mode={mode}
          ariaLabel="Flash"
          autoBadge="A"
          onClick={() => {}}
          testId="flash"
        />,
      );
      return screen.getByTestId("flash").textContent?.trim();
    };

    // On and off share a glyph shape with auto, so without the badge the three
    // states would be two.
    expect(badge("auto")).toBe("A");
    expect(badge("on")).toBe("");
    expect(badge("off")).toBe("");
  });

  test("the target reaches a thumb even though the circle does not", () => {
    render(
      <CameraFlashControl
        mode="off"
        ariaLabel="Flash off"
        autoBadge="A"
        onClick={() => {}}
        testId="flash"
      />,
    );

    // 46px of visible circle, because a wider one crowds the shutter beside it,
    // and 4px of invisible margin on every side taking the pressable box to 54.
    // The platform minimum is 44, and it is the pseudo-element that gets this
    // control there, so a restyle that drops it breaks the one thing about this
    // button nobody can see.
    const className = screen.getByTestId("flash").className;
    expect(className).toContain("size-[46px]");
    expect(className).toContain("after:absolute");
    expect(className).toContain("after:-inset-1");
    expect(className).toContain("after:content-['']");
  });
});
