/**
 * Tests for `VoiceSessionPill`.
 *
 * The pill is purely presentational, so tests drive it directly through
 * props. The embedded `VoiceListeningWaves` is SVG + a rAF loop writing a
 * CSS var — inert under happy-dom, so no harness is needed here.
 *
 * `useIsMobile` is mocked because the pill has two genuinely different forms
 * either side of the `md` breakpoint: an inline control row on desktop, a
 * single sheet trigger on mobile. `mockIsMobile` selects which one is under
 * test; it resets to desktop in `beforeEach`.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import type { LiveVoiceSessionState } from "@/domains/chat/voice/live-voice/live-voice-store";

let mockIsMobile = false;
mock.module("@/hooks/use-is-mobile", () => ({
  useIsMobile: () => mockIsMobile,
  MOBILE_MEDIA_QUERY: "(max-width: 767px)",
}));

// Imported after the mock so the component picks up the mocked module.
const { VoiceSessionErrorChip, VoiceSessionPill } =
  await import("@/domains/chat/components/voice-session-pill");
type VoiceSessionPillProps = React.ComponentProps<typeof VoiceSessionPill>;

beforeEach(() => {
  mockIsMobile = false;
});

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

const stopButton = () =>
  screen.queryByRole("button", { name: "Stop assistant response" });
const endButton = () =>
  screen.getByRole("button", { name: "End voice session" });
const navButton = () =>
  screen.queryByRole("button", { name: "Go to voice session thread" });

describe("VoiceSessionPill — textless surface", () => {
  test("paints no visible label — state reaches AT via a live region only", () => {
    renderPill();
    // The state text must exist for screen readers…
    const live = screen.getByText("Working on App…");
    // …but be visually hidden, so the pill stays narrow enough to leave the
    // header's centre title its room.
    expect(live.className).toContain("sr-only");
    expect(live.getAttribute("aria-live")).toBe("polite");
  });

  test("live region announces muted in place of the state label", () => {
    renderPill({ muted: true });
    expect(screen.getByText("Muted")).toBeTruthy();
    expect(screen.queryByText("Working on App…")).toBeNull();
  });

  test("renders no thread title — the pill takes no secondary label", () => {
    renderPill();
    expect(screen.queryByText("Thread name here")).toBeNull();
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

  test("resting pill is exactly mute + waves + end", () => {
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
  test("the wave strip carries the tap and fires onNavigate only", () => {
    const { onNavigate, onStop, onEnd } = renderPill();
    fireEvent.click(navButton()!);
    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(onStop).not.toHaveBeenCalled();
    expect(onEnd).not.toHaveBeenCalled();
  });

  test("waves stay inert (not a button) without onNavigate", () => {
    // A session with no conversation yet has nowhere to go — the strip must
    // not ship as a dead target.
    renderPill({ onNavigate: undefined });
    expect(navButton()).toBeNull();
  });
});

describe("VoiceSessionPill — condensed mobile form", () => {
  const trigger = () =>
    screen.getByRole("button", { name: "Voice session controls" });

  test("collapses the whole cluster to one trigger", () => {
    mockIsMobile = true;
    renderPill();
    // One trigger, no inline controls: three icon buttons leave the header's
    // centre title unreadable at phone widths.
    expect(trigger()).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Mute microphone" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "End voice session" }),
    ).toBeNull();
  });

  test("a live mic still announces its state without opening the sheet", () => {
    mockIsMobile = true;
    renderPill();
    const live = screen.getByText("Working on App…");
    expect(live.className).toContain("sr-only");
    expect(live.getAttribute("aria-live")).toBe("polite");
  });

  test("opening the sheet offers mute and end, and fires them", () => {
    mockIsMobile = true;
    const { onToggleMute, onEnd } = renderPill();
    fireEvent.click(trigger());
    fireEvent.click(screen.getByText("Mute microphone"));
    expect(onToggleMute).toHaveBeenCalledTimes(1);

    fireEvent.click(trigger());
    fireEvent.click(screen.getByText("End voice session"));
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  test("stop row appears only while speaking", () => {
    mockIsMobile = true;
    const { onStop } = renderPill({ state: "speaking" });
    fireEvent.click(trigger());
    fireEvent.click(screen.getByText("Stop response"));
    expect(onStop).toHaveBeenCalledTimes(1);
    cleanup();

    mockIsMobile = true;
    renderPill({ state: "listening" });
    fireEvent.click(trigger());
    expect(screen.queryByText("Stop response")).toBeNull();
  });

  test("navigate row is omitted when there is no thread to return to", () => {
    mockIsMobile = true;
    renderPill({ onNavigate: undefined });
    fireEvent.click(trigger());
    expect(screen.queryByText("Go to voice session thread")).toBeNull();
  });

  test("muted swaps the trigger glyph's label target, not the control itself", () => {
    // The trigger keeps one stable accessible name in both states — it opens
    // a menu, it is not itself the mute toggle.
    mockIsMobile = true;
    renderPill({ muted: true });
    expect(trigger()).toBeTruthy();
    expect(screen.getByText("Muted")).toBeTruthy();
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
