/**
 * The voice room's centered avatar expresses the session phase and nothing
 * else. The assistant's voice is drawn as a band at the room's floor, so an
 * avatar that tracked it too would put one signal on screen twice. These pin
 * that it reads no audio in any phase: no frame loop, no amplitude property.
 */

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

import { memo } from "react";

import { cleanup, render, screen } from "@testing-library/react";

import type * as ChatAvatarModule from "@/components/avatar/chat-avatar";
import type * as AssistantAvatarModule from "@/hooks/use-assistant-avatar";

import type { VoiceAvatarVisual } from "./voice-avatar-state";

// The avatar query pulls React Query and the daemon graph; the phase classes
// are what this file is about. Both factories are typed against the module
// they replace, so a stub that drifts from the real shape is a type error
// rather than a green suite testing a shape the app does not have.
mock.module(
  "@/hooks/use-assistant-avatar",
  (): Partial<typeof AssistantAvatarModule> => ({
    useAssistantAvatar: () => ({
      components: null,
      traits: null,
      customImageUrl: null,
      state: null,
      isLoading: false,
      isSuccess: true,
      invalidate: () => {},
    }),
  }),
);

// `memo` because the real export is one, and the phase classes live on the
// wrapper above this, so the avatar itself only has to be findable.
mock.module(
  "@/components/avatar/chat-avatar",
  (): Partial<typeof ChatAvatarModule> => ({
    ChatAvatar: memo(() => <div data-testid="chat-avatar" />),
  }),
);

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
