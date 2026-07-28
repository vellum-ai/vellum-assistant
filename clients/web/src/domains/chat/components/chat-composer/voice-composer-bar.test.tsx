/**
 * Tests for `VoiceComposerBar`.
 *
 * The bar is purely presentational, so tests drive it prop-by-prop: state
 * label mapping, control presence, callback wiring, and accessibility
 * attributes. The embedded `VoiceListeningWaves` is SVG + a rAF loop writing
 * a CSS var — inert under happy-dom, so no harness is needed here.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { VoiceComposerBar } from "@/domains/chat/components/chat-composer/voice-composer-bar";
import type { LiveVoiceSessionState } from "@/domains/chat/voice/live-voice/live-voice-store";

afterEach(() => {
  cleanup();
});

function renderBar(
  state: LiveVoiceSessionState,
  overrides?: {
    muted?: boolean;
    onToggleMute?: () => void;
    onEnd?: () => void;
    onStop?: () => void;
    onExpand?: () => void;
    standalone?: boolean;
  },
) {
  return render(
    <VoiceComposerBar
      state={state}
      getAmplitude={() => 0.5}
      muted={overrides?.muted ?? false}
      onToggleMute={overrides?.onToggleMute ?? (() => {})}
      onEnd={overrides?.onEnd ?? (() => {})}
      onStop={overrides?.onStop}
      onExpand={overrides?.onExpand}
      standalone={overrides?.standalone}
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
    test(`announces "${label}" for the ${state} state`, () => {
      renderBar(state);
      expect(screen.getByText(label)).toBeTruthy();
    });
  }

  test("announces state changes via an aria-live region", () => {
    renderBar("listening");
    const label = screen.getByText("Listening…");
    expect(label.getAttribute("aria-live")).toBe("polite");
  });

  test("the state label is visually hidden, not painted", () => {
    // The mic glyph and the animating waves carry "listening" on their own,
    // so the text stays in the tree for assistive tech only.
    renderBar("listening");
    expect(screen.getByText("Listening…").className).toContain("sr-only");
  });
});

describe("VoiceComposerBar — no manual send", () => {
  test("offers no send control in any state", () => {
    // Turns release themselves (server VAD hands-free, auto-release in the
    // manual fallback), so a send control would name an action nobody takes.
    for (const state of [
      "connecting",
      "listening",
      "transcribing",
      "thinking",
      "speaking",
      "ending",
    ] as LiveVoiceSessionState[]) {
      const { unmount } = renderBar(state);
      expect(screen.queryByRole("button", { name: "Send now" })).toBeNull();
      unmount();
    }
  });

  test("end stays enabled in every session state", () => {
    for (const state of [
      "connecting",
      "listening",
      "speaking",
      "ending",
    ] as const) {
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

describe("VoiceComposerBar — expand to room", () => {
  test("renders with onExpand wired and fires it", () => {
    const onExpand = mock(() => {});
    renderBar("listening", { onExpand });
    fireEvent.click(screen.getByRole("button", { name: "Open voice room" }));
    expect(onExpand).toHaveBeenCalledTimes(1);
  });

  test("absent without onExpand (pop-out windows)", () => {
    renderBar("listening");
    expect(
      screen.queryByRole("button", { name: "Open voice room" }),
    ).toBeNull();
  });
});

describe("VoiceComposerBar — structure and accessibility", () => {
  test("bar container is a labelled group", () => {
    renderBar("listening");
    const group = screen.getByRole("group", { name: "Voice session" });
    expect(group).toBeTruthy();
  });

  test("renders the room's listening waves inline", () => {
    const { container } = renderBar("listening");
    expect(
      container.querySelector(".voice-listening-waves--inline"),
    ).toBeTruthy();
  });

  test("standalone supplies its own top padding", () => {
    // When the textarea collapses away for the session the bar is the card's
    // only row, so it can no longer lean on the textarea's top padding.
    const { unmount } = renderBar("listening", { standalone: true });
    expect(
      screen.getByRole("group", { name: "Voice session" }).className,
    ).toContain("pt-3");
    unmount();

    renderBar("listening");
    expect(
      screen.getByRole("group", { name: "Voice session" }).className,
    ).not.toContain("pt-3");
  });

  test("wave strip fades at both edges instead of hard-clipping", () => {
    // Includes the -webkit- prefix: the iOS client is a WKWebView and drops
    // the unprefixed property, which would silently disable the fade there.
    const { container } = renderBar("listening");
    const strip = container.querySelector(
      ".voice-listening-waves--inline",
    )?.parentElement;
    expect(strip?.className).toContain("mask-image:linear-gradient");
    expect(strip?.className).toContain("-webkit-mask-image:linear-gradient");
  });

  test("resting bar is exactly mute + expand + end", () => {
    renderBar("listening", { onExpand: () => {} });
    const names = screen
      .getAllByRole("button")
      .map((b) => b.getAttribute("aria-label"));
    expect(names).toEqual([
      "Mute microphone",
      "Open voice room",
      "End voice session",
    ]);
  });
});
