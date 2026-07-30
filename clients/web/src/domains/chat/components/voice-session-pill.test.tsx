/**
 * Tests for `VoiceSessionPill`.
 *
 * The pill is purely presentational, so tests drive it directly through props.
 * The embedded `VoiceMeshWaves` is a canvas + a rAF loop — inert under
 * happy-dom, so no harness is needed here.
 *
 * The two layouts (`pill` in the header, `row` above it on a phone) are the
 * same surface at two sizes, so most behaviour is asserted once; the layout
 * describe covers only what genuinely differs — the box each one occupies.
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

function renderPill(overrides: Partial<VoiceSessionPillProps> = {}) {
  const handlers = {
    onToggleMute: mock(() => {}),
    onStop: mock(() => {}),
    onEnd: mock(() => {}),
    onNavigate: mock(() => {}),
  };
  render(
    <VoiceSessionPill
      primaryLabel="Working on App…"
      state="listening"
      getAmplitude={() => 0.5}
      muted={false}
      {...handlers}
      {...overrides}
    />,
  );
  return handlers;
}

const root = () => screen.getByRole("group", { name: "Voice session" });
const stopButton = () =>
  screen.queryByRole("button", { name: "Stop assistant response" });
const endButton = () =>
  screen.getByRole("button", { name: "End voice session" });
const navButton = () =>
  screen.queryByRole("button", { name: "Go to voice session thread" });

describe("VoiceSessionPill — state word", () => {
  test("paints the label and announces it from the same node", () => {
    renderPill();
    const label = screen.getByText("Working on App…");
    // One node, not a visible copy plus an sr-only one: a screen reader must
    // announce the state once per change, not twice.
    expect(label.className).not.toContain("sr-only");
    expect(label.getAttribute("aria-live")).toBe("polite");
  });

  test("muted replaces the state label", () => {
    renderPill({ muted: true });
    expect(screen.getByText("Muted")).toBeTruthy();
    expect(screen.queryByText("Working on App…")).toBeNull();
  });

  test("renders no thread title — the pill takes no secondary label", () => {
    renderPill();
    expect(screen.queryByText("Thread name here")).toBeNull();
  });
});

describe("VoiceSessionPill — paint", () => {
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

describe("VoiceSessionPill — layouts", () => {
  test("pill: capped to the header control height, as a no-drag group", () => {
    renderPill();
    expect(root().className).toContain("[-webkit-app-region:no-drag]");
    expect(root().className).toContain("h-8");
    expect(root().className).toContain("rounded-full");
  });

  test("row: a full-width band that takes its own space in flow", () => {
    renderPill({ layout: "row" });
    // Full width and no radius: the row is the page's top edge on a phone, and
    // `shrink-0` is what keeps it pushing the page down rather than being
    // squeezed out of the column.
    expect(root().className).toContain("w-full");
    expect(root().className).toContain("shrink-0");
    expect(root().className).not.toContain("rounded-full");
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
    // The host omits onStop for manual (version-skew fallback) sessions,
    // where stopping a response would end the whole session; the ✕ stays
    // the only destructive control there.
    renderPill({ state: "speaking", onStop: undefined });
    expect(stopButton()).toBeNull();
    expect(endButton()).toBeTruthy();
  });
});

describe("VoiceSessionPill — no manual send", () => {
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

  test("resting surface is exactly mute + state word + end", () => {
    renderPill({ state: "listening" });
    const names = screen
      .getAllByRole("button")
      .map((b) => b.getAttribute("aria-label"));
    expect(names).toEqual([
      "Mute microphone",
      "Go to voice session thread",
      "End voice session",
    ]);
  });
});

describe("VoiceSessionPill — mute toggle", () => {
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

  test("stays reachable in the row layout — a hot mic keeps a one-tap mute", () => {
    const { onToggleMute } = renderPill({ layout: "row" });
    fireEvent.click(screen.getByRole("button", { name: "Mute microphone" }));
    expect(onToggleMute).toHaveBeenCalledTimes(1);
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
  test("the state word carries the tap and fires onNavigate only", () => {
    const { onNavigate, onStop, onEnd } = renderPill();
    fireEvent.click(navButton()!);
    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(onStop).not.toHaveBeenCalled();
    expect(onEnd).not.toHaveBeenCalled();
  });

  test("the state word stays inert (not a button) without onNavigate", () => {
    // A session with no conversation yet has nowhere to go — the surface must
    // not ship a dead target.
    renderPill({ onNavigate: undefined });
    expect(navButton()).toBeNull();
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
