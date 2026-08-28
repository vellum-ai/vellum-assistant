/**
 * The `vision-mode` gate on the composer's Eyes control. The toggle is the
 * feature's only entry point, so an off flag has to leave the row exactly as it
 * was.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, render, screen } from "@testing-library/react";

import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";

import { SightToggle } from "./sight-toggle";

function setVisionModeFlag(value: "off" | "on") {
  act(() => {
    useClientFeatureFlagStore
      .getState()
      .setStringFlags({ visionMode: value }, null);
  });
}

beforeEach(() => {
  setVisionModeFlag("off");
});

afterEach(() => {
  cleanup();
});

describe("SightToggle", () => {
  test("renders nothing when the vision-mode flag is off", () => {
    render(<SightToggle />);

    expect(
      screen.queryByRole("button", { name: "Turn on camera vision" }),
    ).toBeNull();
  });

  test("renders the control when the flag is on", () => {
    setVisionModeFlag("on");
    render(<SightToggle />);

    const toggle = screen.getByRole("button", {
      name: "Turn on camera vision",
    });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
  });
});
