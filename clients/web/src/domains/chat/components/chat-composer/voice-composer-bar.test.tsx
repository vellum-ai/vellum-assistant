/**
 * Tests for `VoiceComposerBar`.
 *
 * The bar is purely presentational, so tests drive it prop-by-prop: state
 * label mapping, send-button enablement, callback wiring, and accessibility
 * attributes. The embedded `VoiceTimelineWaveform` renders a real canvas —
 * happy-dom's `getContext("2d")` returns `null`, which that component
 * handles by skipping its draw loop, so no canvas/rAF harness is needed
 * here (its rendering behavior is covered by its own test file).
 */

import { afterEach, describe, expect, mock, test } from "bun:test";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { VoiceComposerBar } from "@/domains/chat/components/chat-composer/voice-composer-bar";
import type { LiveVoiceSessionState } from "@/domains/chat/voice/live-voice/live-voice-store";

afterEach(() => {
  cleanup();
});

function renderBar(state: LiveVoiceSessionState, overrides?: {
  muted?: boolean;
  onToggleMute?: () => void;
  onEnd?: () => void;
  onSend?: () => void;
  onStop?: () => void;
}) {
  return render(
    <VoiceComposerBar
      state={state}
      getAmplitude={() => 0.5}
      muted={overrides?.muted ?? false}
      onToggleMute={overrides?.onToggleMute ?? (() => {})}
      onEnd={overrides?.onEnd ?? (() => {})}
      onSend={overrides?.onSend ?? (() => {})}
      onStop={overrides?.onStop}
    />,
  );
}

describe("VoiceComposerBar — state label", () => {
  const labels: Array<[LiveVoiceSessionState, string]> = [
    ["connecting", "Connecting…"],
    ["listening", "Listening…"],
    ["transcribing", "Transcribing…"],
    ["thinking", "Thinking…"],
    ["speaking", "Speaking…"],
    ["ending", "Ending…"],
  ];

  for (const [state, label] of labels) {
    test(`renders "${label}" for the ${state} state`, () => {
      renderBar(state);
      expect(screen.getByText(label)).toBeTruthy();
    });
  }

  test("announces state changes via an aria-live region", () => {
    renderBar("listening");
    const label = screen.getByText("Listening…");
    expect(label.getAttribute("aria-live")).toBe("polite");
  });
});

describe("VoiceComposerBar — send enablement", () => {
  test("send is enabled while listening", () => {
    renderBar("listening");
    const send = screen.getByRole("button", { name: "Send now" });
    expect((send as HTMLButtonElement).disabled).toBe(false);
  });

  const nonListening: LiveVoiceSessionState[] = [
    "connecting",
    "transcribing",
    "thinking",
    "speaking",
    "ending",
  ];

  for (const state of nonListening) {
    test(`send is disabled while ${state}`, () => {
      renderBar(state);
      const send = screen.getByRole("button", { name: "Send now" });
      expect((send as HTMLButtonElement).disabled).toBe(true);
    });
  }

  test("end stays enabled in every session state", () => {
    for (const state of ["connecting", "listening", "speaking", "ending"] as const) {
      const { unmount } = renderBar(state);
      const end = screen.getByRole("button", { name: "End voice session" });
      expect((end as HTMLButtonElement).disabled).toBe(false);
      unmount();
    }
  });
});

describe("VoiceComposerBar — callbacks", () => {
  test("clicking end fires onEnd", () => {
    const onEnd = mock(() => {});
    renderBar("speaking", { onEnd });
    fireEvent.click(screen.getByRole("button", { name: "End voice session" }));
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  test("clicking send while listening fires onSend", () => {
    const onSend = mock(() => {});
    renderBar("listening", { onSend });
    fireEvent.click(screen.getByRole("button", { name: "Send now" }));
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  test("clicking send while disabled does not fire onSend", () => {
    const onSend = mock(() => {});
    renderBar("thinking", { onSend });
    fireEvent.click(screen.getByRole("button", { name: "Send now" }));
    expect(onSend).not.toHaveBeenCalled();
  });
});

describe("VoiceComposerBar — mute toggle", () => {
  test("shows 'Mute microphone' when live and fires onToggleMute", () => {
    const onToggleMute = mock(() => {});
    renderBar("listening", { onToggleMute });
    fireEvent.click(screen.getByRole("button", { name: "Mute microphone" }));
    expect(onToggleMute).toHaveBeenCalledTimes(1);
  });

  test("muted: offers unmute and replaces the state label with 'Muted'", () => {
    renderBar("listening", { muted: true });
    expect(
      screen.getByRole("button", { name: "Unmute microphone" }),
    ).toBeTruthy();
    expect(screen.getByText("Muted")).toBeTruthy();
    expect(screen.queryByText("Listening…")).toBeNull();
  });
});

describe("VoiceComposerBar — stop response", () => {
  test("■ renders only while speaking with onStop wired, and fires it", () => {
    const onStop = mock(() => {});
    renderBar("speaking", { onStop });
    fireEvent.click(
      screen.getByRole("button", { name: "Stop assistant response" }),
    );
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  test("no ■ outside speaking, or without onStop (manual session)", () => {
    const { unmount } = renderBar("listening", { onStop: () => {} });
    expect(
      screen.queryByRole("button", { name: "Stop assistant response" }),
    ).toBeNull();
    unmount();

    renderBar("speaking");
    expect(
      screen.queryByRole("button", { name: "Stop assistant response" }),
    ).toBeNull();
  });
});

describe("VoiceComposerBar — structure and accessibility", () => {
  test("bar container is a labelled group", () => {
    renderBar("listening");
    const group = screen.getByRole("group", { name: "Voice session" });
    expect(group).toBeTruthy();
  });

  test("renders the timeline waveform canvas", () => {
    const { container } = renderBar("listening");
    expect(container.querySelector("canvas")).toBeTruthy();
  });

  test("both control buttons carry aria labels", () => {
    renderBar("listening");
    expect(
      screen.getByRole("button", { name: "End voice session" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Send now" })).toBeTruthy();
  });
});
