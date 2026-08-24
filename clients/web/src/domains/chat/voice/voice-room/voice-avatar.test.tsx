/**
 * The voice room's centered avatar expresses the session phase and nothing
 * else. It used to ride the TTS output through a per-frame custom property,
 * which put the assistant's voice on screen twice once the floor band existed,
 * so these pin that it reads no audio at all: no frame loop, no amplitude
 * property, whatever phase it is in.
 */

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

import { cleanup, render, screen } from "@testing-library/react";

import type { VoiceAvatarVisual } from "./voice-avatar-state";

// The avatar query pulls React Query and the daemon graph; the phase classes
// are what this file is about.
mock.module("@/hooks/use-assistant-avatar", () => ({
  useAssistantAvatar: () => ({
    components: null,
    traits: null,
    customImageUrl: null,
  }),
}));

mock.module("@/components/avatar/chat-avatar", () => ({
  ChatAvatar: () => <div data-testid="chat-avatar" />,
}));

const { VoiceAvatar } = await import("./voice-avatar");

const VISUALS: VoiceAvatarVisual[] = [
  "idle",
  "listening",
  "thinking",
  "responding",
  "reconnecting",
];

/** The node carrying the phase class, found by that class rather than by
 *  nesting, so the assertions do not double as a DOM-shape test. */
function avatarNode(): HTMLElement {
  const node = document.querySelector<HTMLElement>(".voice-avatar");
  if (!node) {
    throw new Error("avatar node missing");
  }
  return node;
}

let rafSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  rafSpy = spyOn(window, "requestAnimationFrame");
});

afterEach(() => {
  rafSpy.mockRestore();
  cleanup();
});

describe("VoiceAvatar", () => {
  test("carries the phase as a class, in every phase", () => {
    for (const visual of VISUALS) {
      render(<VoiceAvatar assistantId="assistant-1" visual={visual} />);
      expect(avatarNode().className).toContain(`voice-avatar--${visual}`);
      cleanup();
    }
  });

  test("schedules no frame loop while responding", () => {
    // A rAF here would only ever be an amplitude poll: the phase treatments are
    // CSS loops, and the entry spring belongs to the room.
    render(<VoiceAvatar assistantId="assistant-1" visual="responding" />);
    expect(rafSpy).not.toHaveBeenCalled();
  });

  test("writes no amplitude property in any phase", () => {
    for (const visual of VISUALS) {
      render(<VoiceAvatar assistantId="assistant-1" visual={visual} />);
      expect(avatarNode().style.getPropertyValue("--voice-amp")).toBe("");
      cleanup();
    }
  });

  test("renders the fallback avatar with no assistant", () => {
    render(<VoiceAvatar assistantId={null} visual="idle" />);
    expect(screen.getByTestId("chat-avatar")).toBeTruthy();
  });
});
