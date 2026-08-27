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
import { COMPOSER_RADIUS_CLASS } from "@/domains/chat/components/chat-composer/composer-mobile-chrome";
import type { LiveVoiceSessionState } from "@/domains/chat/voice/live-voice/live-voice-store";
import type { VoiceSurfacePaint } from "@/domains/chat/voice/voice-room/voice-surface-paint";
import { stubViewportAxes } from "@/hooks/viewport-axes.test-helper";
import { toneForBg } from "@/utils/avatar-tone";

afterEach(() => {
  cleanup();
});

const INPUT_LEVEL = 0.5;
const OUTPUT_LEVEL = 0.25;

/** The paint a session on a dark avatar color resolves to. The default here. */
const DARK_PAINT: VoiceSurfacePaint = {
  bgHex: "#123524",
  tone: toneForBg("#123524"),
};
/** The same, for an avatar color light enough to flip the chrome. */
const LIGHT_PAINT: VoiceSurfacePaint = {
  bgHex: "#F3E8C8",
  tone: toneForBg("#F3E8C8"),
};

function renderBar(
  state: LiveVoiceSessionState,
  overrides?: {
    muted?: boolean;
    onToggleMute?: () => void;
    onEnd?: () => void;
    outputMuted?: boolean;
    onToggleOutputMute?: () => void;
    paint?: VoiceSurfacePaint | null;
    onExpand?: () => void;
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
      outputMuted={overrides?.outputMuted ?? false}
      onToggleOutputMute={overrides?.onToggleOutputMute ?? (() => {})}
      paint={overrides?.paint === undefined ? DARK_PAINT : overrides.paint}
      onExpand={overrides?.onExpand}
    />,
  );
}

/** The `sr-only` live region that announces the state. */
function liveRegion(): HTMLElement | undefined {
  return screen
    .getAllByText(/…|Muted/)
    .find((el) => el.className.includes("sr-only"));
}

describe("VoiceComposerBar: state announcement", () => {
  const labels: Array<[LiveVoiceSessionState, string]> = [
    ["connecting", "Connecting…"],
    ["listening", "Listening…"],
    // Shares `thinking`'s wording on purpose (JARVIS-1559).
    ["transcribing", "Thinking…"],
    ["thinking", "Thinking…"],
    ["speaking", "Speaking…"],
    ["ending", "Ending…"],
  ];

  for (const [state, label] of labels) {
    test(`announces "${label}" for the ${state} state`, () => {
      renderBar(state);
      expect(liveRegion()?.textContent).toBe(label);
    });
  }

  test("paints no state word: the band is the readout", () => {
    // The block says what it is doing by moving. A word over the band competed
    // with it and gave the surface one more thing to read.
    renderBar("listening");
    const painted = screen
      .getAllByText(/…|Muted/)
      .filter((el) => !el.className.includes("sr-only"));
    expect(painted).toEqual([]);
  });

  test("announces state changes via an aria-live region", () => {
    renderBar("listening");
    expect(liveRegion()?.getAttribute("aria-live")).toBe("polite");
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

  test("muted: offers unmute and announces 'Muted' in place of the state", () => {
    renderBar("listening", { muted: true });
    expect(
      screen.getByRole("button", { name: "Unmute microphone" }),
    ).toBeTruthy();
    expect(liveRegion()?.textContent).toBe("Muted");
    expect(screen.queryByText("Listening…")).toBeNull();
  });
});

describe("VoiceComposerBar: assistant mute", () => {
  test("offers the mute and fires it, in every state", () => {
    // Persistent, like the room's: the pair of mutes never changes shape
    // mid-turn, so neither moves out from under a reaching finger.
    for (const state of ["listening", "thinking", "speaking"] as const) {
      const onToggleOutputMute = mock(() => {});
      const { unmount } = renderBar(state, { onToggleOutputMute });
      fireEvent.click(screen.getByRole("button", { name: "Mute assistant" }));
      expect(onToggleOutputMute).toHaveBeenCalledTimes(1);
      unmount();
    }
  });

  test("muted: offers unmute and reflects the pressed state", () => {
    renderBar("speaking", { outputMuted: true });
    const toggle = screen.getByRole("button", { name: "Unmute assistant" });
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
  });
});

describe("VoiceComposerBar: no transient stop", () => {
  test("offers no ■ in any state", () => {
    // Muting the assistant replaced it: a control that appeared and vanished
    // with the reply changed the row's shape twice a turn.
    for (const state of [
      "listening",
      "thinking",
      "speaking",
    ] as LiveVoiceSessionState[]) {
      const { unmount } = renderBar(state);
      expect(
        screen.queryByRole("button", { name: "Stop assistant response" }),
      ).toBeNull();
      unmount();
    }
  });
});

describe("VoiceComposerBar — expand to room", () => {
  test("the centre reopens the room", () => {
    // The way back is the band, not a fourth icon: it is the bar's largest
    // region, and seeing the session again is the likeliest thing to want
    // from a minimized one.
    const onExpand = mock(() => {});
    renderBar("listening", { onExpand });
    fireEvent.click(screen.getByRole("button", { name: "Open voice room" }));
    expect(onExpand).toHaveBeenCalledTimes(1);
  });

  test("the centre is the flexible middle, not a chip beside the icons", () => {
    renderBar("listening", { onExpand: () => {} });
    const { className } = screen.getByRole("button", {
      name: "Open voice room",
    });
    expect(className).toContain("flex-1");
    expect(className).toContain("self-stretch");
  });

  test("no separate expand control remains", () => {
    // It was a fourth icon on a rail of 16px targets; the centre replaced it.
    renderBar("listening", { onExpand: () => {} });
    const icons = screen
      .getAllByRole("button")
      .filter((b) => b.className.includes("--room-fg-muted"));
    expect(icons).toHaveLength(3);
  });

  test("inert without onExpand (pop-out windows)", () => {
    // A button that opens nothing is worse than no button.
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

  test("is a single control row, not a composer-sized block", () => {
    // The bar sits above a composer that stays on screen and usable, so it
    // takes one control row's height rather than standing in for the
    // composer's own footprint the way it used to.
    renderBar("listening");
    const { className } = screen.getByRole("group", { name: "Voice session" });
    expect(className).toContain("h-10");
    expect(className).not.toContain("h-[5.25rem]");
  });

  test("takes the chat input's corners, not the header pill's capsule", () => {
    // The pill is round because it turns up on pages the session did not start
    // on and has to read as a visitor from another thread. Stacked on its own
    // conversation's composer there is nothing foreign to announce, so the bar
    // matches the card under it and the two read as one control area.
    renderBar("listening");
    const { className } = screen.getByRole("group", { name: "Voice session" });
    expect(className).toContain(COMPOSER_RADIUS_CLASS);
    expect(className).not.toContain("rounded-full");
  });

  test("wears the mobile card's pill radius at mobile widths", () => {
    // The card under it is a 26px pill there, and a 10px bar 8px above a pill
    // reads as two unrelated widgets rather than one control area.
    const restore = stubViewportAxes({ narrow: true, coarsePointer: true });
    try {
      renderBar("listening");
      const { className } = screen.getByRole("group", {
        name: "Voice session",
      });
      expect(className).toContain("rounded-[26px]");
      expect(className).not.toContain(COMPOSER_RADIUS_CLASS);
    } finally {
      restore();
    }
  });

  test("paints itself in the room's fill rather than inheriting a card's", () => {
    // The composer under it keeps the app's normal surface now, so the fill
    // and the `--room-*` chrome contract have to travel with the bar.
    renderBar("listening", { paint: LIGHT_PAINT });
    const group = screen.getByRole("group", { name: "Voice session" });
    expect(group.getAttribute("style")).toContain(LIGHT_PAINT.bgHex);
    expect(group.getAttribute("data-theme")).toBe("light");
  });

  test("holds the app's own surface until the avatar color resolves", () => {
    // `useVoiceSurfacePaint` returns null while the query is in flight; a bar
    // that painted on that read would flash the ambient dark and then the
    // avatar color.
    renderBar("listening", { paint: null });
    const group = screen.getByRole("group", { name: "Voice session" });
    expect(group.className).toContain("bg-[var(--surface-lift)]");
    expect(group.getAttribute("data-theme")).toBeNull();
  });

  test("controls are toned for the avatar color, not theme tokens", () => {
    // The block is painted an arbitrary avatar color, so chrome that read
    // `--content-default` would be as likely to vanish into it as contrast.
    renderBar("listening", { onExpand: () => {} });
    for (const name of [
      "Mute microphone",
      "Mute assistant",
      "End voice session",
    ]) {
      expect(screen.getByRole("button", { name }).className).toContain(
        "--room-fg-muted",
      );
    }
  });

  test("controls stay bare on touch, at full tap size", () => {
    // On touch the design library gives an icon-only ghost Button an opaque
    // chip and a theme foreground, which reads as a tile floating on the
    // block's avatar-colored fill. The override drops the chip and keeps the
    // 40px target, which comes from a separate pair of classes.
    renderBar("listening", { onExpand: () => {} });
    const { className } = screen.getByRole("button", {
      name: "End voice session",
    });
    expect(className).not.toContain("touch-mobile:bg-[var(--surface-lift)]");
    expect(className).toContain("touch-mobile:bg-transparent");
    expect(className).toContain("touch-mobile:[--vbtn-fg:var(--room-fg-muted");
    expect(className).toContain("touch-mobile:h-10");
  });

  test("the band fades at both edges instead of hard-clipping", () => {
    // Includes the -webkit- prefix: the iOS client is a WKWebView and drops
    // the unprefixed property, which would silently disable the fade there.
    renderBar("listening");
    const band = screen.getByTestId("voice-session-band");
    expect(band.className).toContain("mask-image:linear-gradient");
    expect(band.className).toContain("-webkit-mask-image:linear-gradient");
  });

  test("the block holds the room's control set, and nothing else", () => {
    // The room's own three, in the same reading order — the two mutes (one per
    // direction of the conversation) and end — with the way back into the room
    // sitting between them as the band it is drawn on.
    renderBar("listening", { onExpand: () => {} });
    const names = screen
      .getAllByRole("button")
      .map((b) => b.getAttribute("aria-label"));
    expect(names).toEqual([
      "Mute microphone",
      "Open voice room",
      "Mute assistant",
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

describe("VoiceComposerBar: muted controls stay visible", () => {
  test("a muted control inks itself against the fill, not the theme", () => {
    // The negative token is a mid-tone red and the block is painted an
    // arbitrary avatar color, so the two can land close enough that the muted
    // glyph vanishes into the fill. Inline, so it beats the resting
    // `--vbtn-fg` regardless of how Tailwind orders the two utilities.
    renderBar("listening", { muted: true });
    const style =
      screen
        .getByRole("button", { name: "Unmute microphone" })
        .getAttribute("style") ?? "";
    expect(style).toContain("--vbtn-fg");
    expect(style.toUpperCase()).toContain("#FCA5A5");
  });

  test("a light fill gets the deep red instead of the pale one", () => {
    renderBar("listening", { muted: true, paint: LIGHT_PAINT });
    const style =
      screen
        .getByRole("button", { name: "Unmute microphone" })
        .getAttribute("style") ?? "";
    expect(style.toUpperCase()).toContain("#991B1B");
  });

  test("a muted assistant inks itself the same way", () => {
    renderBar("speaking", { outputMuted: true });
    const style =
      screen
        .getByRole("button", { name: "Unmute assistant" })
        .getAttribute("style") ?? "";
    expect(style.toUpperCase()).toContain("#FCA5A5");
  });
});
