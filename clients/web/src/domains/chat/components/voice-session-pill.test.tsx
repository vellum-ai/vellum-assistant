/**
 * Tests for `VoiceSessionPill`.
 *
 * The pill is purely presentational, so tests drive it directly through
 * props. The embedded `VoiceTimelineWaveform` renders a real canvas —
 * happy-dom's `getContext("2d")` returns `null`, which that component treats
 * as "don't start the draw loop", so no canvas harness is needed here (its
 * own test file covers the drawing behavior).
 */

import { afterEach, describe, expect, mock, test } from "bun:test";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import type { LiveVoiceSessionState } from "@/domains/chat/voice/live-voice/live-voice-store";
import {
  VoiceSessionPill,
  type VoiceSessionPillProps,
} from "@/domains/chat/components/voice-session-pill";

afterEach(() => {
  cleanup();
});

function renderPill(overrides: Partial<VoiceSessionPillProps> = {}) {
  const handlers = {
    onStop: mock(() => {}),
    onEnd: mock(() => {}),
    onSend: mock(() => {}),
    onNavigate: mock(() => {}),
  };
  render(
    <VoiceSessionPill
      primaryLabel="Working on App…"
      secondaryLabel="Thread name here"
      state="listening"
      getAmplitude={() => 0.5}
      {...handlers}
      {...overrides}
    />,
  );
  return handlers;
}

const stopButton = () => screen.queryByRole("button", { name: "Stop assistant response" });
const endButton = () => screen.getByRole("button", { name: "End voice session" });
const sendButton = () => screen.getByRole("button", { name: "Send now" });
const labelButton = () => screen.queryByRole("button", { name: "Go to voice session thread" });

describe("VoiceSessionPill — labels", () => {
  test("renders both label lines with truncation", () => {
    renderPill();
    const primary = screen.getByText("Working on App…");
    const secondary = screen.getByText("Thread name here");
    expect(primary.className).toContain("truncate");
    expect(secondary.className).toContain("truncate");
  });

  test("omits the secondary line when not provided", () => {
    renderPill({ secondaryLabel: undefined });
    expect(screen.getByText("Working on App…")).toBeTruthy();
    expect(screen.queryByText("Thread name here")).toBeNull();
  });

  test("label area is a plain (non-interactive) element without onNavigate", () => {
    renderPill({ onNavigate: undefined });
    expect(labelButton()).toBeNull();
    expect(screen.getByText("Working on App…")).toBeTruthy();
  });
});

describe("VoiceSessionPill — title-bar constraints", () => {
  test("root is a no-drag group capped to the header control height", () => {
    renderPill();
    const root = screen.getByRole("group", { name: "Voice session" });
    expect(root.className).toContain("[-webkit-app-region:no-drag]");
    expect(root.className).toContain("h-8");
  });
});

describe("VoiceSessionPill — stop control", () => {
  test("hidden outside the speaking state", () => {
    for (const state of [
      "connecting",
      "listening",
      "transcribing",
      "thinking",
      "ending",
    ] as LiveVoiceSessionState[]) {
      renderPill({ state });
      expect(stopButton()).toBeNull();
      cleanup();
    }
  });

  test("shown while speaking and fires onStop", () => {
    const { onStop, onNavigate } = renderPill({ state: "speaking" });
    fireEvent.click(stopButton()!);
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(onNavigate).not.toHaveBeenCalled();
  });

  test("hidden even while speaking when onStop is not provided", () => {
    // Hosts omit onStop while stopping a response would end the whole
    // session (V1 interrupt); the ✕ stays the only destructive control.
    renderPill({ state: "speaking", onStop: undefined });
    expect(stopButton()).toBeNull();
    expect(endButton()).toBeTruthy();
  });
});

describe("VoiceSessionPill — send control", () => {
  test("enabled while listening and fires onSend", () => {
    const { onSend, onNavigate } = renderPill({ state: "listening" });
    const send = sendButton();
    expect(send.hasAttribute("disabled")).toBe(false);
    fireEvent.click(send);
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onNavigate).not.toHaveBeenCalled();
  });

  test("disabled in every non-listening state", () => {
    for (const state of [
      "connecting",
      "transcribing",
      "thinking",
      "speaking",
      "ending",
    ] as LiveVoiceSessionState[]) {
      const { onSend } = renderPill({ state });
      const send = sendButton();
      expect(send.hasAttribute("disabled")).toBe(true);
      fireEvent.click(send);
      expect(onSend).not.toHaveBeenCalled();
      cleanup();
    }
  });
});

describe("VoiceSessionPill — end control", () => {
  test("always enabled and fires onEnd", () => {
    const { onEnd, onNavigate } = renderPill({ state: "thinking" });
    const end = endButton();
    expect(end.hasAttribute("disabled")).toBe(false);
    fireEvent.click(end);
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onNavigate).not.toHaveBeenCalled();
  });
});

describe("VoiceSessionPill — navigation", () => {
  test("clicking the label area fires onNavigate only", () => {
    const { onNavigate, onStop, onEnd, onSend } = renderPill();
    fireEvent.click(labelButton()!);
    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(onStop).not.toHaveBeenCalled();
    expect(onEnd).not.toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
  });
});
