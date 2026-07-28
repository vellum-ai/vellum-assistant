import { describe, expect, it } from "bun:test";

import type { LiveVoiceSessionState } from "@/domains/chat/voice/live-voice/live-voice-store";

import { toVoiceAvatarVisual, type VoiceAvatarVisual } from "./voice-avatar-state";

// Every session phase paired with both `reconnecting` values (8 × 2 = 16).
const CASES: ReadonlyArray<{
  state: LiveVoiceSessionState;
  reconnecting: boolean;
  expected: VoiceAvatarVisual;
}> = [
  { state: "idle", reconnecting: false, expected: "idle" },
  { state: "idle", reconnecting: true, expected: "idle" },
  { state: "connecting", reconnecting: false, expected: "idle" },
  { state: "connecting", reconnecting: true, expected: "reconnecting" },
  { state: "listening", reconnecting: false, expected: "listening" },
  { state: "listening", reconnecting: true, expected: "listening" },
  { state: "transcribing", reconnecting: false, expected: "thinking" },
  { state: "transcribing", reconnecting: true, expected: "thinking" },
  { state: "thinking", reconnecting: false, expected: "thinking" },
  { state: "thinking", reconnecting: true, expected: "thinking" },
  { state: "speaking", reconnecting: false, expected: "responding" },
  { state: "speaking", reconnecting: true, expected: "responding" },
  { state: "ending", reconnecting: false, expected: "idle" },
  { state: "ending", reconnecting: true, expected: "idle" },
  { state: "failed", reconnecting: false, expected: "idle" },
  { state: "failed", reconnecting: true, expected: "idle" },
];

describe("toVoiceAvatarVisual", () => {
  for (const { state, reconnecting, expected } of CASES) {
    it(`maps ${state} (reconnecting=${reconnecting}) → ${expected}`, () => {
      expect(toVoiceAvatarVisual(state, reconnecting)).toBe(expected);
    });
  }

  it("only maps connecting to reconnecting when reconnecting is set", () => {
    expect(toVoiceAvatarVisual("connecting", true)).toBe("reconnecting");
    expect(toVoiceAvatarVisual("connecting", false)).toBe("idle");
    // reconnecting must be ignored for every non-connecting phase.
    expect(toVoiceAvatarVisual("listening", true)).toBe("listening");
    expect(toVoiceAvatarVisual("speaking", true)).toBe("responding");
  });

  it("defaults assistantAudioActive to true (speaking → responding)", () => {
    // Callers without the audio signal keep the plain mapping.
    expect(toVoiceAvatarVisual("speaking", false)).toBe("responding");
  });

  it("maps speaking → thinking when no audio is flowing", () => {
    // A turn that spoke an ack and is now running a tool stays `speaking` but
    // is silent; the avatar must read `thinking`, not `responding` (JARVIS-1279).
    expect(toVoiceAvatarVisual("speaking", false, false)).toBe("thinking");
    expect(toVoiceAvatarVisual("speaking", true, false)).toBe("thinking");
  });

  it("keeps speaking → responding while audio is flowing", () => {
    expect(toVoiceAvatarVisual("speaking", false, true)).toBe("responding");
  });

  it("ignores assistantAudioActive for every non-speaking phase", () => {
    // The flag is only meaningful while `speaking`; it must not perturb others.
    expect(toVoiceAvatarVisual("listening", false, false)).toBe("listening");
    expect(toVoiceAvatarVisual("thinking", false, false)).toBe("thinking");
    expect(toVoiceAvatarVisual("thinking", false, true)).toBe("thinking");
    expect(toVoiceAvatarVisual("idle", false, false)).toBe("idle");
  });
});
