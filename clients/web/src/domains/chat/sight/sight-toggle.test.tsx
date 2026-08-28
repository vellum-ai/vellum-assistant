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

const toggle = () =>
  screen.queryByRole("button", { name: "Turn on camera vision" });

describe("SightToggle", () => {
  test("renders nothing when the vision-mode flag is off", () => {
    render(<SightToggle imageAttachmentsAllowed />);

    expect(toggle()).toBeNull();
  });

  test("renders the control when the flag is on", () => {
    setVisionModeFlag("on");
    render(<SightToggle imageAttachmentsAllowed />);

    expect(toggle()?.getAttribute("aria-pressed")).toBe("false");
  });

  test("renders nothing where an image would not survive the turn", () => {
    // A legacy assistant on a profile with no vision: the provider rejects the
    // image and fails the whole turn, so the camera is not offered rather than
    // offered with its frames quietly dropped.
    setVisionModeFlag("on");
    render(<SightToggle imageAttachmentsAllowed={false} />);

    expect(toggle()).toBeNull();
  });
});
