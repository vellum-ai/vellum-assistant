/**
 * Tests for `LiveVoiceOverlay`.
 *
 * Verifies the overlay's lifecycle contract:
 *   - Renders `null` when state is `off` (no DOM presence).
 *   - Renders a non-empty status label for every other state.
 *   - Renders the error message in the `failed` state.
 *   - Re-renders partial / final / assistant transcript text when the
 *     store mutates.
 *
 * Uses `@testing-library/react` against happy-dom (registered via
 * `apps/web/test-setup.ts`). The store is mutated via `act()` so React
 * flushes the resulting re-render before assertions.
 */

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "bun:test";

import { LiveVoiceOverlay } from "@/domains/voice/live-voice/live-voice-overlay";
import {
  type LiveVoiceState,
  useLiveVoiceStore,
} from "@/domains/voice/live-voice/live-voice-store";

afterEach(() => {
  cleanup();
  useLiveVoiceStore.getState().reset();
});

describe("LiveVoiceOverlay", () => {
  test("renders null when state is off", () => {
    const { container } = render(<LiveVoiceOverlay />);
    expect(container.firstChild).toBeNull();
  });

  test("renders a status label for each non-off state", () => {
    const cases: ReadonlyArray<{ state: LiveVoiceState; label: string }> = [
      { state: "connecting", label: "Connecting…" },
      { state: "listening", label: "Listening…" },
      { state: "transcribing", label: "Listening…" },
      { state: "thinking", label: "Thinking…" },
      { state: "speaking", label: "Speaking…" },
      { state: "ending", label: "Ending…" },
      { state: "failed", label: "Connection failed" },
    ];

    for (const { state, label } of cases) {
      act(() => {
        useLiveVoiceStore.getState().setState(state);
      });

      const { unmount } = render(<LiveVoiceOverlay />);
      const status = screen.getByRole("status");
      expect(status.textContent ?? "").toContain(label);
      unmount();

      act(() => {
        useLiveVoiceStore.getState().reset();
      });
    }
  });

  test("renders the error message when state is failed", () => {
    act(() => {
      useLiveVoiceStore.getState().setState("failed");
      useLiveVoiceStore.getState().setError("mic permission denied");
    });

    render(<LiveVoiceOverlay />);

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe("mic permission denied");
  });

  test("does not render the error region in non-failed states", () => {
    act(() => {
      useLiveVoiceStore.getState().setState("listening");
      // Even if an old error message is hanging around in the store, a
      // non-failed state must not surface it — error display is gated
      // on state, not on the presence of an errorMessage.
      useLiveVoiceStore.getState().setError("stale error");
    });

    render(<LiveVoiceOverlay />);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("re-renders partial, final, and assistant transcripts when the store updates", () => {
    act(() => {
      useLiveVoiceStore.getState().setState("listening");
    });

    render(<LiveVoiceOverlay />);

    act(() => {
      useLiveVoiceStore.getState().setFinalTranscript("hello");
    });
    expect(screen.getByRole("status").textContent).toContain("hello");

    act(() => {
      useLiveVoiceStore.getState().setPartialTranscript("world");
    });
    expect(screen.getByRole("status").textContent).toContain("hello");
    expect(screen.getByRole("status").textContent).toContain("world");

    act(() => {
      useLiveVoiceStore.getState().appendAssistantTranscript("sure thing");
    });
    expect(screen.getByRole("status").textContent).toContain("sure thing");
  });

  test("amplitude bar width tracks the input amplitude (clamped to [0, 1])", () => {
    act(() => {
      useLiveVoiceStore.getState().setState("listening");
      useLiveVoiceStore.getState().setInputAmplitude(0.42);
    });

    const { container } = render(<LiveVoiceOverlay />);
    const fill = container.querySelector(
      '[data-slot="live-voice-overlay-amplitude-fill"]',
    ) as HTMLElement | null;
    expect(fill).not.toBeNull();
    expect(fill?.style.width).toBe("42%");

    // Out-of-range values must clamp rather than overflow the bar.
    act(() => {
      useLiveVoiceStore.getState().setInputAmplitude(2);
    });
    expect(fill?.style.width).toBe("100%");

    act(() => {
      useLiveVoiceStore.getState().setInputAmplitude(-1);
    });
    expect(fill?.style.width).toBe("0%");
  });

  test("forwards className overrides onto the overlay root", () => {
    act(() => {
      useLiveVoiceStore.getState().setState("listening");
    });

    const { container } = render(<LiveVoiceOverlay className="custom-layout" />);
    const root = container.querySelector(
      '[data-slot="live-voice-overlay"]',
    ) as HTMLElement | null;
    expect(root).not.toBeNull();
    expect(root?.className).toContain("custom-layout");
  });
});
