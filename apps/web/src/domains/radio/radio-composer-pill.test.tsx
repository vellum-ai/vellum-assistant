import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement, type ReactNode } from "react";

import type { ResolvedRadioTrack } from "@/domains/radio/types.js";
import { useRadioStore } from "@/domains/radio/radio-store.js";

let lastNavigatedTo: string | null = null;

const passthrough = ({ children }: { children?: ReactNode }) =>
  createElement("div", null, children);
let currentPopoverOpen = false;
let lastPopoverOpenChange: ((open: boolean) => void) | null = null;

mock.module("@vellum/design-library", () => ({
  Button: ({
    children,
    iconOnly,
    leftIcon,
    onClick,
    active: _active,
    tintColor: _tintColor,
    variant: _variant,
    size: _size,
    ...props
  }: {
    children?: ReactNode;
    iconOnly?: ReactNode;
    leftIcon?: ReactNode;
    onClick?: () => void;
  } & Record<string, unknown>) =>
    createElement(
      "button",
      { onClick, ...props },
      iconOnly,
      leftIcon,
      children,
    ),
  Popover: {
    Root: ({
      children,
      open,
      onOpenChange,
    }: {
      children?: ReactNode;
      open?: boolean;
      onOpenChange?: (open: boolean) => void;
    }) => {
      currentPopoverOpen = !!open;
      lastPopoverOpenChange = onOpenChange ?? null;
      return createElement("div", null, children);
    },
    Trigger: passthrough,
    Content: ({ children }: { children?: ReactNode }) =>
      currentPopoverOpen
        ? createElement("div", { "data-testid": "radio-popover" }, children)
        : null,
  },
}));

mock.module("react-router", () => ({
  useNavigate: () => (path: string) => {
    lastNavigatedTo = path;
  },
}));

const { RadioComposerPill } = await import(
  "@/domains/radio/radio-composer-pill.js"
);

const track: ResolvedRadioTrack = {
  id: "track-1",
  title: "A Very Long Song Title That Needs Truncation",
  artist: "Example Artist",
  durationMs: 180000,
  audioPath: "/runtime/audio/track-1.mp3",
  audioUrl: "/runtime/audio/track-1.mp3",
  sourceLabel: "Generated",
  license: "repo-generated",
  sha256: "abc123",
};

const nextTrack: ResolvedRadioTrack = {
  ...track,
  id: "track-2",
  title: "Next Song",
  artist: "Example Artist Two",
  audioPath: "/runtime/audio/track-2.mp3",
  audioUrl: "/runtime/audio/track-2.mp3",
};

afterEach(() => {
  cleanup();
  useRadioStore.getState().reset();
  lastNavigatedTo = null;
  currentPopoverOpen = false;
  lastPopoverOpenChange = null;
});

describe("RadioComposerPill", () => {
  test("renders the compact collapsed cue with a stable-width countdown", () => {
    useRadioStore.setState({
      status: "playing",
      displayCue: "song",
      currentTrack: track,
      remainingMs: 65000,
      isExpanded: false,
    });

    render(<RadioComposerPill assistantId="assistant-123" />);

    expect(screen.getByText("On Air")).toBeTruthy();
    expect(screen.getByText("Song")).toBeTruthy();
    expect(screen.getByText("1:05")).toBeTruthy();
    expect(screen.getByLabelText("Open radio controls")).toBeTruthy();
  });

  test("renders expanded track, next track, progress, DJ transcript, and controls", () => {
    useRadioStore.setState({
      status: "playing",
      displayCue: "dj",
      isExpanded: true,
      currentTrack: track,
      nextTrack,
      progressMs: 45000,
      remainingMs: 135000,
      djText: "Coming up next: something with a little more voltage.",
    });

    render(<RadioComposerPill assistantId="assistant-123" />);

    expect(screen.getByText(track.title)).toBeTruthy();
    expect(screen.getByText(track.artist)).toBeTruthy();
    expect(screen.getByText(/Next Song/)).toBeTruthy();
    expect(screen.getByText("Coming up next: something with a little more voltage.")).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("25");
    expect(screen.getByLabelText("Pause radio")).toBeTruthy();
    expect(screen.getByLabelText("Skip radio segment")).toBeTruthy();
    expect(screen.getByLabelText("Hide radio")).toBeTruthy();
  });

  test("renders setup-needed content with settings CTA", () => {
    useRadioStore.setState({
      status: "setup_needed",
      displayCue: "setup_needed",
      isExpanded: true,
      currentTrack: track,
      setup: {
        reason: "tts_not_configured",
        settingsPath: "/assistant/settings/ai",
        message: "Text-to-speech needs configuration.",
      },
    });

    render(<RadioComposerPill assistantId="assistant-123" />);

    expect(screen.getAllByText("Setup").length).toBeGreaterThan(0);
    expect(screen.getByText("Text-to-speech needs configuration.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Configure Text-to-Speech" })).toBeTruthy();
  });

  test("hide and show use the session store without changing feature flags", () => {
    useRadioStore.setState({
      status: "playing",
      displayCue: "song",
      isExpanded: true,
      currentTrack: track,
    });

    const { rerender } = render(<RadioComposerPill assistantId="assistant-123" />);
    fireEvent.click(screen.getByLabelText("Hide radio"));

    expect(useRadioStore.getState().isHidden).toBe(true);
    expect(screen.queryByText("On Air")).toBeNull();

    rerender(<RadioComposerPill assistantId="assistant-123" />);
    fireEvent.click(screen.getByRole("button", { name: "Show radio" }));

    expect(useRadioStore.getState().isHidden).toBe(false);
    expect(screen.getByText("On Air")).toBeTruthy();
  });

  test("settings CTA navigates to Settings AI", () => {
    useRadioStore.setState({
      status: "setup_needed",
      displayCue: "setup_needed",
      isExpanded: true,
      currentTrack: track,
      setup: {
        reason: "tts_unavailable",
        settingsPath: "/assistant/settings/ai",
        message: "Open settings to configure Text-to-Speech.",
      },
    });

    render(<RadioComposerPill assistantId="assistant-123" />);
    fireEvent.click(screen.getByRole("button", { name: "Configure Text-to-Speech" }));

    expect(lastNavigatedTo).toBe("/assistant/settings/ai");
  });

  test("popover open changes are idempotent", () => {
    useRadioStore.setState({
      status: "playing",
      displayCue: "song",
      isExpanded: true,
      currentTrack: track,
    });

    render(<RadioComposerPill assistantId="assistant-123" />);

    act(() => {
      lastPopoverOpenChange?.(false);
      lastPopoverOpenChange?.(false);
    });
    expect(useRadioStore.getState().isExpanded).toBe(false);

    act(() => {
      lastPopoverOpenChange?.(true);
      lastPopoverOpenChange?.(true);
    });
    expect(useRadioStore.getState().isExpanded).toBe(true);
  });

  test("shows idle controls instead of stale station state from another assistant", () => {
    useRadioStore.setState({
      assistantId: "assistant-a",
      status: "playing",
      displayCue: "song",
      isExpanded: true,
      currentTrack: track,
      remainingMs: 65000,
    });

    render(<RadioComposerPill assistantId="assistant-b" />);

    expect(screen.queryByText(track.title)).toBeNull();
    expect(screen.getAllByText("Off").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Radio").length).toBeGreaterThan(0);
    expect(screen.getByLabelText("Play radio")).toBeTruthy();
    expect(
      screen.getByLabelText("Skip radio segment").getAttribute("disabled"),
    ).not.toBeNull();
  });
});
