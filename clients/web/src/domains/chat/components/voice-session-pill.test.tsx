/**
 * Tests for `VoiceSessionPill`.
 *
 * The pill is purely presentational, so tests drive it directly through props.
 * The embedded `VoiceMeshWaves` is a canvas plus a rAF loop, inert under
 * happy-dom, so no harness is needed here.
 *
 * The two layouts (`pill` in the header, `row` above it on a phone) are the
 * same surface at two sizes, so most behaviour is asserted once; the layout
 * describe covers only what genuinely differs: the box each one occupies.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import type { LiveVoiceSessionState } from "@/domains/chat/voice/live-voice/live-voice-store";
import type { VoiceSurfacePaint } from "@/domains/chat/voice/voice-room/voice-surface-paint";
import { toneForBg } from "@/utils/avatar-tone";

import {
  VoiceSessionErrorChip,
  VoiceSessionPill,
} from "@/domains/chat/components/voice-session-pill";

type VoiceSessionPillProps = React.ComponentProps<typeof VoiceSessionPill>;

const YELLOW_PAINT: VoiceSurfacePaint = {
  bgHex: "#F5C518",
  tone: toneForBg("#F5C518"),
};
const NAVY_PAINT: VoiceSurfacePaint = {
  bgHex: "#17191C",
  tone: toneForBg("#17191C"),
};

afterEach(() => {
  cleanup();
});

const INPUT_LEVEL = 0.5;
const OUTPUT_LEVEL = 0.25;

function renderPill(overrides: Partial<VoiceSessionPillProps> = {}) {
  const handlers = {
    onToggleMute: mock(() => {}),
    onToggleOutputMute: mock(() => {}),
    onEnd: mock(() => {}),
    onNavigate: mock(() => {}),
  };
  render(
    <VoiceSessionPill
      primaryLabel="Working on App…"
      state="listening"
      getAmplitude={() => INPUT_LEVEL}
      getOutputAmplitude={() => OUTPUT_LEVEL}
      muted={false}
      outputMuted={false}
      {...handlers}
      {...overrides}
    />,
  );
  return handlers;
}

const root = () => screen.getByRole("group", { name: "Voice session" });
const endButton = () =>
  screen.getByRole("button", { name: "End voice session" });
const navButton = () =>
  screen.queryByRole("button", { name: "Go to voice session thread" });

describe("VoiceSessionPill: state announcement", () => {
  test("paints no words: the band is the readout", () => {
    renderPill();
    const label = screen.getByText("Working on App…");
    // The state reaches assistive tech only. A word over the band competed
    // with the motion and gave the surface one more thing to read.
    expect(label.className).toContain("sr-only");
    expect(label.getAttribute("aria-live")).toBe("polite");
  });

  test("muted is announced in place of the state", () => {
    renderPill({ muted: true });
    expect(screen.getByText("Muted")).toBeTruthy();
    expect(screen.queryByText("Working on App…")).toBeNull();
  });

  test("renders no thread title — the pill takes no secondary label", () => {
    renderPill();
    expect(screen.queryByText("Thread name here")).toBeNull();
  });
});

describe("VoiceSessionPill: paint", () => {
  test("fills with the room's colour and publishes its tones", () => {
    renderPill({ paint: YELLOW_PAINT });
    const style = root().getAttribute("style") ?? "";
    // The fill is an arbitrary avatar colour, so chrome on it reads these
    // rather than theme tokens.
    expect(style).toContain("--room-fg");
    expect(style).toContain("--room-fg-muted");
    expect(style).toContain("--room-wash");
    expect(root().className).not.toContain("bg-[var(--surface-lift)]");
  });

  test("flips data-theme with the fill's polarity", () => {
    renderPill({ paint: YELLOW_PAINT });
    // Light fill: descendants reading plain theme tokens must go light with it.
    expect(root().getAttribute("data-theme")).toBe("light");
    cleanup();

    renderPill({ paint: NAVY_PAINT });
    expect(root().getAttribute("data-theme")).toBe("dark");
  });

  test("holds the app's lift surface until the paint resolves", () => {
    // `paint` is null while the avatar query is in flight. Painting the
    // ambient dark there would flash the surface through a colour it never
    // settles on.
    renderPill();
    expect(root().className).toContain("bg-[var(--surface-lift)]");
    expect(root().getAttribute("data-theme")).toBeNull();
  });
});

describe("VoiceSessionPill: layouts", () => {
  test("pill: capped to the header control height, as a no-drag group", () => {
    renderPill();
    expect(root().className).toContain("[-webkit-app-region:no-drag]");
    expect(root().className).toContain("h-8");
    expect(root().className).toContain("rounded-full");
    // Held off its neighbours in the cluster: the header's own gap is tuned
    // for icon buttons, not for a painted capsule.
    expect(root().className).toContain("mx-2");
  });

  test("row: the same pill stretched edge to edge, taking its own space in flow", () => {
    renderPill({ layout: "row" });
    // Edge to edge, and still a pill: the row is one shape with the header
    // pill rather than a squared-off band. `shrink-0` is what keeps it pushing
    // the page down rather than being squeezed out of the column.
    expect(root().className).toContain("w-full");
    expect(root().className).toContain("shrink-0");
    expect(root().className).toContain("rounded-full");
    // No side margin here: the header pill's breathing room would pull this
    // one off both edges.
    expect(root().className).not.toContain("mx-2");
  });
});

describe("VoiceSessionPill: controls on touch", () => {
  // The design library gives an icon-only ghost Button an opaque chip on touch
  // (`touch-mobile:bg-[var(--surface-lift)]` plus a theme foreground). That is
  // right on app chrome and wrong on a surface painted an arbitrary avatar
  // color, where it lands as a theme-colored tile floating on the fill. These
  // assert the merge outcome, which is the whole of the bug: the overrides are
  // only worth anything if tailwind-merge drops the library's classes.
  test("no theme chip survives on the row's controls", () => {
    renderPill({ layout: "row", paint: NAVY_PAINT });
    for (const name of [
      "Mute microphone",
      "Mute assistant",
      "End voice session",
    ]) {
      const { className } = screen.getByRole("button", { name });
      expect(className).not.toContain("touch-mobile:bg-[var(--surface-lift)]");
      expect(className).not.toContain(
        "touch-mobile:[--vbtn-fg:var(--content-default)]",
      );
      expect(className).toContain("touch-mobile:bg-transparent");
      expect(className).toContain(
        "touch-mobile:[--vbtn-fg:var(--room-fg-muted",
      );
    }
  });

  test("the 40px touch target survives the override", () => {
    // The tap target comes from a separate `touch-mobile:h-10 w-10` pair, so
    // dropping the chip must not shrink the control back to desktop size.
    renderPill({ layout: "row", paint: NAVY_PAINT });
    const { className } = screen.getByRole("button", {
      name: "End voice session",
    });
    expect(className).toContain("touch-mobile:h-10");
    expect(className).toContain("touch-mobile:w-10");
  });
});

describe("VoiceSessionPill: muted controls stay visible", () => {
  test("a muted mic inks itself against the fill, not the theme", () => {
    // The negative token is a mid-tone red and the surface is painted an
    // arbitrary avatar color, so the two can land close enough that the muted
    // glyph vanishes into the fill. Inline, so it beats the resting
    // `--vbtn-fg` regardless of how Tailwind orders the two utilities.
    renderPill({ muted: true, paint: NAVY_PAINT });
    const style =
      screen
        .getByRole("button", { name: "Unmute microphone" })
        .getAttribute("style") ?? "";
    expect(style).toContain("--vbtn-fg");
    expect(style.toUpperCase()).toContain("#FCA5A5");
  });

  test("a light fill gets the deep red instead of the pale one", () => {
    renderPill({ muted: true, paint: YELLOW_PAINT });
    const style =
      screen
        .getByRole("button", { name: "Unmute microphone" })
        .getAttribute("style") ?? "";
    expect(style.toUpperCase()).toContain("#991B1B");
  });

  test("a muted assistant inks itself the same way", () => {
    renderPill({ outputMuted: true, paint: NAVY_PAINT });
    const style =
      screen
        .getByRole("button", { name: "Unmute assistant" })
        .getAttribute("style") ?? "";
    expect(style.toUpperCase()).toContain("#FCA5A5");
  });

  test("an unpainted surface falls back to the theme's negative token", () => {
    renderPill({ muted: true });
    const style =
      screen
        .getByRole("button", { name: "Unmute microphone" })
        .getAttribute("style") ?? "";
    expect(style).toContain("--system-negative-strong");
  });
});

describe("VoiceSessionPill: assistant mute", () => {
  test("offers the mute in every state and fires it", () => {
    // Persistent, like the room's: the pair of mutes never changes shape
    // mid-turn, so neither moves out from under a reaching finger.
    for (const state of [
      "connecting",
      "listening",
      "thinking",
      "speaking",
    ] as LiveVoiceSessionState[]) {
      const { onToggleOutputMute } = renderPill({ state });
      fireEvent.click(screen.getByRole("button", { name: "Mute assistant" }));
      expect(onToggleOutputMute).toHaveBeenCalledTimes(1);
      cleanup();
    }
  });

  test("muted: offers unmute and reflects the pressed state", () => {
    renderPill({ state: "speaking", outputMuted: true });
    const toggle = screen.getByRole("button", { name: "Unmute assistant" });
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
  });

  test("offers no transient stop in any state", () => {
    // Muting the assistant replaced it: a control that appeared and vanished
    // with the reply changed the surface's shape twice a turn.
    for (const state of [
      "listening",
      "thinking",
      "speaking",
    ] as LiveVoiceSessionState[]) {
      renderPill({ state });
      expect(
        screen.queryByRole("button", { name: "Stop assistant response" }),
      ).toBeNull();
      cleanup();
    }
  });
});

describe("VoiceSessionPill: no manual send", () => {
  test("offers no send control in any state", () => {
    // Turns release themselves (server VAD hands-free, auto-release in the
    // manual fallback), so a send affordance would name a no-op action and
    // cost the header ~40px it cannot spare.
    for (const state of [
      "connecting",
      "listening",
      "transcribing",
      "thinking",
      "speaking",
      "ending",
    ] as LiveVoiceSessionState[]) {
      renderPill({ state });
      expect(screen.queryByRole("button", { name: "Send now" })).toBeNull();
      cleanup();
    }
  });

  test("the surface holds the room's control set, and nothing else", () => {
    // The two mutes (one per direction of the conversation) with the band
    // between them, which is also the way back to the thread.
    renderPill({ state: "listening" });
    const names = screen
      .getAllByRole("button")
      .map((b) => b.getAttribute("aria-label"));
    expect(names).toEqual([
      "Mute microphone",
      "Go to voice session thread",
      "Mute assistant",
      "End voice session",
    ]);
  });
});

describe("VoiceSessionPill: mute toggle", () => {
  test("live: offers mute and fires onToggleMute", () => {
    const { onToggleMute } = renderPill();
    fireEvent.click(screen.getByRole("button", { name: "Mute microphone" }));
    expect(onToggleMute).toHaveBeenCalledTimes(1);
  });

  test("muted: offers unmute and reflects the pressed state", () => {
    const { onToggleMute } = renderPill({ muted: true });
    const toggle = screen.getByRole("button", { name: "Unmute microphone" });
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(toggle);
    expect(onToggleMute).toHaveBeenCalledTimes(1);
  });

  test("stays reachable in the row layout: a hot mic keeps a one-tap mute", () => {
    const { onToggleMute } = renderPill({ layout: "row" });
    fireEvent.click(screen.getByRole("button", { name: "Mute microphone" }));
    expect(onToggleMute).toHaveBeenCalledTimes(1);
  });
});

describe("VoiceSessionPill: end control", () => {
  test("always enabled and fires onEnd", () => {
    const { onEnd, onNavigate } = renderPill({ state: "thinking" });
    const end = endButton();
    expect(end.hasAttribute("disabled")).toBe(false);
    fireEvent.click(end);
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onNavigate).not.toHaveBeenCalled();
  });
});

describe("VoiceSessionPill: navigation", () => {
  test("the band's middle carries the tap and fires onNavigate only", () => {
    const { onNavigate, onToggleOutputMute, onEnd } = renderPill();
    fireEvent.click(navButton()!);
    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(onToggleOutputMute).not.toHaveBeenCalled();
    expect(onEnd).not.toHaveBeenCalled();
  });

  test("the band's middle stays inert (not a button) without onNavigate", () => {
    // A session with no conversation yet has nowhere to go, so the surface must
    // not ship a dead target.
    renderPill({ onNavigate: undefined });
    expect(navButton()).toBeNull();
    // The state is still announced; only the tap target goes.
    expect(screen.getByText("Working on App…")).toBeTruthy();
  });
});

describe("VoiceSessionErrorChip", () => {
  function renderChip() {
    const onDismiss = mock(() => {});
    render(
      <VoiceSessionErrorChip
        message="Microphone capture could not start."
        onDismiss={onDismiss}
      />,
    );
    return onDismiss;
  }

  test("announces the failure as an alert carrying the message", () => {
    renderChip();
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Microphone capture could not start.");
    expect(alert.className).toContain("[-webkit-app-region:no-drag]");
    expect(alert.className).toContain("h-8");
  });

  test("dismiss button fires onDismiss", () => {
    const onDismiss = renderChip();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  test("dismiss button carries the Tag primitive's keyboard focus ring", () => {
    // The chip composes the design-library Tag; its remove button must keep a
    // keyboard focus affordance (matching Notice's dismiss button), not a
    // bare outline-none.
    renderChip();
    const dismiss = screen.getByRole("button", { name: "Dismiss" });
    expect(dismiss.className).toContain("keyboard-focus:ring-2");
    expect(dismiss.className).toContain("keyboard-focus:ring-[var(--ring)]");
  });
});
