/**
 * The vision-mode gates on the composer's Eyes control, and what a live call
 * does to it. The toggle is the feature's only entry point, so an off flag has
 * to leave the row exactly as it was.
 *
 * Two arms guard it, and the interesting one is the shipped pair: `vision-mode`
 * on with `vision-mode-chat` off is the voice room having sight while the
 * composer does not, which is what makes the in-chat surface switchable on its
 * own.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, render, screen } from "@testing-library/react";

import { useLiveVoiceStore } from "@/domains/chat/voice/live-voice/live-voice-store";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";

import { SightToggle } from "./sight-toggle";

function setVisionFlags(vision: "off" | "on", chat: "off" | "on") {
  act(() => {
    useClientFeatureFlagStore
      .getState()
      .setStringFlags({ visionMode: vision, visionModeChat: chat }, null);
  });
}

beforeEach(() => {
  setVisionFlags("off", "off");
  act(() => {
    useLiveVoiceStore.getState().reset();
  });
});

afterEach(() => {
  cleanup();
});

const toggle = () =>
  screen.queryByRole("button", { name: "Turn on camera vision" });

describe("SightToggle", () => {
  test("renders nothing while vision is on but chat is not", () => {
    // The shipped pair: the voice room has its sight features and the composer
    // has no camera to open.
    setVisionFlags("on", "off");
    render(<SightToggle imageAttachmentsAllowed />);

    expect(toggle()).toBeNull();
  });

  test("renders nothing while chat is on but vision is not", () => {
    // The chat arm sits on top of the feature rather than beside it, so on its
    // own it reaches nothing.
    setVisionFlags("off", "on");
    render(<SightToggle imageAttachmentsAllowed />);

    expect(toggle()).toBeNull();
  });

  test("renders nothing when both arms are off", () => {
    render(<SightToggle imageAttachmentsAllowed />);

    expect(toggle()).toBeNull();
  });

  test("renders the control when both arms are on", () => {
    setVisionFlags("on", "on");
    render(<SightToggle imageAttachmentsAllowed />);

    expect(toggle()?.getAttribute("aria-pressed")).toBe("false");
  });

  test("is disabled, and says why, while a call holds the camera", () => {
    // Disabled rather than hidden: the room raises its own viewfinder, so the
    // camera is not gone, and a control that vanished mid-call would read as
    // the feature breaking.
    setVisionFlags("on", "on");
    render(<SightToggle imageAttachmentsAllowed />);
    expect(toggle()).not.toBeNull();

    act(() => {
      useLiveVoiceStore.getState().setState("listening");
    });

    const busy = screen.getByRole("button", {
      name: "The voice call is using the camera",
    });
    expect(busy.hasAttribute("disabled")).toBe(true);
  });

  test("renders nothing where an image would not survive the turn", () => {
    // A legacy assistant on a profile with no vision: the provider rejects the
    // image and fails the whole turn, so the camera is not offered rather than
    // offered with its frames quietly dropped.
    setVisionFlags("on", "on");
    render(<SightToggle imageAttachmentsAllowed={false} />);

    expect(toggle()).toBeNull();
  });
});
