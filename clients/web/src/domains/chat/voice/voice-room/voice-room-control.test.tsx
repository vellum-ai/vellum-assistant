/**
 * Tests for `VoiceRoomControl`, every circular icon control in the room.
 *
 * Only what a real room render cannot reach. The camera fills and the shared
 * 52px size are proved in `voice-room.test.tsx`, against the room's own
 * controls with the viewfinder genuinely open; asserting them again here
 * against a bare harness proves one branch twice and leaves two places to fix
 * when the palette moves.
 *
 * What is left is the paint contract the control publishes for itself, since
 * the deep-link overlay mounts these outside the room entirely, and the `live`
 * tone off camera mode, where the `media` surface is one the room never
 * renders at all.
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
  test("the camera fills are published as vars by the control itself", () => {
    // Nothing above this in the tree is guaranteed to carry the contract: the
    // deep-link overlay mounts these controls outside the room entirely.
    const style = renderControl({ surface: "camera" }).getAttribute("style");
    expect(style).toContain("--camera-warm");
    expect(style).toContain("--camera-destructive");
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
