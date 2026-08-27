/**
 * Tests for `VoiceRoomControl`, every circular icon control in the room.
 *
 * Load-bearing contracts: the three surfaces, since a control that reads the
 * wrong one is invisible rather than merely wrong; the `live` tone, whose whole
 * job is to exist only where a viewfinder covers the room's own look; and the
 * corner's exemption from the camera fills, which is what keeps the bottom row
 * reading as one set of related acts.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { cleanup, render, screen } from "@testing-library/react";

import {
  VoiceRoomControl,
  type VoiceRoomControlProps,
} from "@/domains/chat/voice/voice-room/voice-room-control";

afterEach(() => {
  cleanup();
});

function renderControl(props: Partial<VoiceRoomControlProps> = {}) {
  render(
    <VoiceRoomControl
      label="Mute microphone"
      onClick={() => {}}
      data-testid="c"
      {...props}
    >
      <span />
    </VoiceRoomControl>,
  );
  return screen.getByTestId("c");
}

describe("VoiceRoomControl", () => {
  test("camera mode fills every tone, and tells them apart by what they do", () => {
    // White for the control that says the session is live, warm for the ones
    // that are about the camera rather than the call, red for the one act that
    // cannot be undone.
    expect(
      renderControl({ surface: "camera", tone: "live" }).className,
    ).toContain("bg-white");
    cleanup();
    expect(renderControl({ surface: "camera" }).className).toContain(
      "bg-[var(--camera-warm)]",
    );
    cleanup();
    expect(
      renderControl({ surface: "camera", tone: "destructive" }).className,
    ).toContain("bg-[var(--camera-destructive)]");
  });

  test("an engaged toggle sits a shade heavier than its resting peers", () => {
    // The camera control is held down for the whole time the viewfinder is up;
    // flip, beside it, toggles nothing.
    expect(
      renderControl({ surface: "camera", pressed: true }).className,
    ).toContain("bg-[var(--camera-warm-strong)]");
  });

  test("the camera fills are published as vars by the control itself", () => {
    // Nothing above this in the tree is guaranteed to carry the contract: the
    // deep-link overlay mounts these controls outside the room entirely.
    const style = renderControl({ surface: "camera" }).getAttribute("style");
    expect(style).toContain("--camera-warm");
    expect(style).toContain("--camera-destructive");
  });

  test("corner chrome keeps the glass treatment in camera mode", () => {
    // A filled circle in the corner would join the bottom row's set of related
    // acts, which the minimize control is not part of.
    const bare = renderControl({ surface: "camera", bare: true });
    expect(bare.className).toContain("bg-black/45");
    expect(bare.className).not.toContain("camera-warm");
  });

  test("the live tone is the neutral one anywhere but camera mode", () => {
    // Off the viewfinder the room's own look answers "is she listening", so a
    // solid white circle would be an answer to a question already answered,
    // and it would be the loudest thing in a room built around an avatar.
    const room = renderControl({ tone: "live" });
    expect(room.className).toContain("border-[var(--room-border)]");
    expect(room.className).not.toContain("bg-white");
    cleanup();

    // The deep-link capture overlay is over video without being in camera
    // mode: it has no `--camera-*` contract, and its two controls are chrome
    // on a modal rather than a session row.
    const media = renderControl({ tone: "live", surface: "media" });
    expect(media.className).toContain("bg-black/45");
    expect(media.className).not.toContain("bg-white");
  });
});
