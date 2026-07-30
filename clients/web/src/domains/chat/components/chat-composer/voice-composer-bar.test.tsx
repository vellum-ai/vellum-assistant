/**
 * Tests for `VoiceComposerBar`.
 *
 * The bar is purely presentational, so tests drive it prop-by-prop: state
 * label mapping, control presence, callback wiring, and accessibility
 * attributes.
 *
 * `VoiceMeshWaves` is a canvas plus a rAF loop, inert under happy-dom, so the
 * band is stubbed with a probe that records the props it was handed. That is
 * the only way to assert what the band is drawing (its ink and which voice it
 * rides), which is otherwise invisible to a DOM test.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";

let lastBandProps: {
  getAmplitude: () => number;
  color?: string;
  peakOpacity?: number;
} | null = null;
mock.module("@/domains/chat/voice/voice-room/voice-mesh-waves", () => ({
  MESH_INLINE_TUNING: {},
  VoiceMeshWaves: (props: {
    getAmplitude: () => number;
    color?: string;
    peakOpacity?: number;
  }) => {
    lastBandProps = props;
    return null;
  },
}));

const { VoiceComposerBar } =
  await import("@/domains/chat/components/chat-composer/voice-composer-bar");
import type { LiveVoiceSessionState } from "@/domains/chat/voice/live-voice/live-voice-store";

afterEach(() => {
  cleanup();
});

const INPUT_LEVEL = 0.5;
const OUTPUT_LEVEL = 0.25;

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
      getAmplitude={() => INPUT_LEVEL}
      getOutputAmplitude={() => OUTPUT_LEVEL}
      muted={overrides?.muted ?? false}
      onToggleMute={overrides?.onToggleMute ?? (() => {})}
      onEnd={overrides?.onEnd ?? (() => {})}
      onStop={overrides?.onStop}
      onExpand={overrides?.onExpand}
      standalone={overrides?.standalone}
    />,
  );
}

/** The painted state word, as distinct from the `sr-only` live region. */
function visibleLabel(): HTMLElement | undefined {
  return screen
    .getAllByText(/…|Muted/)
    .find((el) => !el.className.includes("sr-only"));
}

/** The `sr-only` live region that announces the state. */
function liveRegion(): HTMLElement | undefined {
  return screen
    .getAllByText(/…|Muted/)
    .find((el) => el.className.includes("sr-only"));
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
    test(`shows "${label}" for the ${state} state`, () => {
      renderBar(state);
      expect(visibleLabel()?.textContent).toBe(label);
    });
  }

  test("the state word is painted in the block", () => {
    // The block is a surface, not a toolbar: the state word sits in it beside
    // the band, so the minimized session says what it is doing.
    renderBar("listening");
    expect(visibleLabel()).toBeTruthy();
  });

  test("announces state changes via a separate aria-live region", () => {
    renderBar("listening");
    expect(liveRegion()?.getAttribute("aria-live")).toBe("polite");
  });

  test("the painted word is hidden from assistive tech, so it is not read twice", () => {
    // The live region already announces the state. Leaving the painted copy
    // exposed would have a screen reader read it a second time.
    renderBar("listening");
    expect(visibleLabel()?.getAttribute("aria-hidden")).toBe("true");
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
    expect(visibleLabel()?.textContent).toBe("Muted");
    expect(liveRegion()?.textContent).toBe("Muted");
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

  test("renders the room's band across the block", () => {
    renderBar("listening");
    const band = screen.getByTestId("voice-session-band");
    // Filling the block, behind everything: the color and the motion are one
    // surface, not a strip in a middle column.
    expect(band.className).toContain("absolute inset-0");
    expect(lastBandProps).not.toBeNull();
  });

  test("standalone takes the composer's footprint, otherwise it is a control row", () => {
    // Owning the card, the block holds the height the composer it replaced
    // had, so minimizing does not shift the thread above it. Sharing the card
    // with the live transcript, it stays a row under it.
    const { unmount } = renderBar("listening", { standalone: true });
    expect(
      screen.getByRole("group", { name: "Voice session" }).className,
    ).toContain("h-[5.25rem]");
    unmount();

    renderBar("listening");
    expect(
      screen.getByRole("group", { name: "Voice session" }).className,
    ).not.toContain("h-[5.25rem]");
  });

  test("controls are toned for the avatar color, not theme tokens", () => {
    // The block is painted an arbitrary avatar color, so chrome that read
    // `--content-default` would be as likely to vanish into it as contrast.
    renderBar("listening", { onExpand: () => {} });
    for (const name of [
      "Mute microphone",
      "Open voice room",
      "End voice session",
    ]) {
      expect(screen.getByRole("button", { name }).className).toContain(
        "--room-fg-muted",
      );
    }
  });

  test("the band fades at both edges instead of hard-clipping", () => {
    // Includes the -webkit- prefix: the iOS client is a WKWebView and drops
    // the unprefixed property, which would silently disable the fade there.
    renderBar("listening");
    const band = screen.getByTestId("voice-session-band");
    expect(band.className).toContain("mask-image:linear-gradient");
    expect(band.className).toContain("-webkit-mask-image:linear-gradient");
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

describe("VoiceComposerBar: the band", () => {
  test("rides the mic in a pale ink while listening", () => {
    renderBar("listening");
    // Pale over the fill, per the room's own pairing. The block is painted the
    // avatar color, so an accent-tinted band would be that same hue and paint
    // nothing at all.
    expect(lastBandProps?.color).toBe("#FFFFFF");
    expect(lastBandProps?.getAmplitude()).toBe(INPUT_LEVEL);
  });

  test("rides the reply in a darker ink while the assistant speaks", () => {
    renderBar("speaking");
    expect(lastBandProps?.color).toBe("#000000");
    // The mic is closed through the reply, so a band on the input level would
    // sit flat for that whole half of the turn.
    expect(lastBandProps?.getAmplitude()).toBe(OUTPUT_LEVEL);
  });

  test("keeps riding the mic while the turn is being worked on", () => {
    // The mic is open through transcribing/thinking (barge-in), so the block
    // stays alive with the user's own level rather than flattening.
    renderBar("thinking");
    expect(lastBandProps?.getAmplitude()).toBe(INPUT_LEVEL);
  });

  test("empties the floor when neither voice is present", () => {
    renderBar("connecting");
    expect(lastBandProps?.getAmplitude()).toBe(0);
  });

  test("a muted mic reads silent, not frozen", () => {
    renderBar("listening", { muted: true });
    expect(lastBandProps?.getAmplitude()).toBe(0);
  });
});
