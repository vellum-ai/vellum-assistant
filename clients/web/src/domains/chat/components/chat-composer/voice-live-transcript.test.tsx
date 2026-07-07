/**
 * Tests for `VoiceLiveTranscript`.
 *
 * The component subscribes to the real live-voice store (that self-sourcing
 * is its whole point — the composer deliberately does not re-render on
 * transcript deltas), so tests drive it by writing transcript fields through
 * the store and asserting the rendered surface: partial/final precedence,
 * store-driven clearing, the empty-renders-nothing contract, and the caret's
 * reduced-motion behavior (verified by stubbing `motion/react`, mirroring
 * `voice-timeline-waveform.test.tsx`).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { act, cleanup, render, screen } from "@testing-library/react";

import { useLiveVoiceStore } from "@/domains/chat/voice/live-voice/live-voice-store";

import { VoiceLiveTranscript } from "@/domains/chat/components/chat-composer/voice-live-transcript";

beforeEach(() => {
  useLiveVoiceStore.getState().reset();
});

afterEach(() => {
  cleanup();
  useLiveVoiceStore.getState().reset();
});

function seedTranscripts(partial: string, final = "") {
  act(() => {
    useLiveVoiceStore.getState().setPartialTranscript(partial);
    useLiveVoiceStore.getState().setFinalTranscript(final);
  });
}

describe("VoiceLiveTranscript — transcript text", () => {
  test("renders the partial transcript as display-only text", () => {
    seedTranscripts("hello wor");
    render(<VoiceLiveTranscript />);
    const region = screen.getByLabelText("Voice transcript");
    expect(region.textContent).toContain("hello wor");
  });

  test("prefers the partial over the final while both are present", () => {
    // Same precedence as the old inline strip's `liveVoicePartial ||
    // liveVoiceFinal`: the in-flight partial is the fresher signal.
    seedTranscripts("still speaking", "previous final");
    render(<VoiceLiveTranscript />);
    const region = screen.getByLabelText("Voice transcript");
    expect(region.textContent).toContain("still speaking");
    expect(region.textContent).not.toContain("previous final");
  });

  test("falls back to the final transcript when no partial is in flight", () => {
    seedTranscripts("", "what I said");
    render(<VoiceLiveTranscript />);
    expect(
      screen.getByLabelText("Voice transcript").textContent,
    ).toContain("what I said");
  });

  test("streams partial updates without remounting", () => {
    seedTranscripts("hel");
    render(<VoiceLiveTranscript />);
    act(() => {
      useLiveVoiceStore.getState().setPartialTranscript("hello world");
    });
    expect(
      screen.getByLabelText("Voice transcript").textContent,
    ).toContain("hello world");
  });
});

describe("VoiceLiveTranscript — empty and clearing", () => {
  test("renders nothing while both transcripts are empty", () => {
    const { container } = render(<VoiceLiveTranscript />);
    // Nothing in the composer's text area — the disabled textarea's
    // placeholder shows through (Light 53 baseline).
    expect(container.innerHTML).toBe("");
    expect(screen.queryByLabelText("Voice transcript")).toBeNull();
  });

  test("clears when the store resets", () => {
    seedTranscripts("about to be sent", "about to be sent");
    const { container } = render(<VoiceLiveTranscript />);
    expect(screen.getByLabelText("Voice transcript")).toBeTruthy();

    act(() => {
      useLiveVoiceStore.getState().reset();
    });

    expect(screen.queryByLabelText("Voice transcript")).toBeNull();
    expect(container.innerHTML).toBe("");
  });
});

describe("VoiceLiveTranscript — accessibility and styling", () => {
  test("announces updates via a polite live region", () => {
    seedTranscripts("hello");
    render(<VoiceLiveTranscript />);
    const region = screen.getByLabelText("Voice transcript");
    expect(region.getAttribute("aria-live")).toBe("polite");
  });

  test("styles the text like the composer textarea and caps growth at maxHeightPx", () => {
    seedTranscripts("hello");
    render(<VoiceLiveTranscript className="col-start-1" maxHeightPx={240} />);
    const region = screen.getByLabelText("Voice transcript");
    // Same font class + text inset as the textarea, so speech reads as
    // typed composer text; caller placement classes are merged in.
    expect(region.className).toContain("text-chat");
    expect(region.className).toContain("px-4");
    expect(region.className).toContain("col-start-1");
    expect(region.style.maxHeight).toBe("240px");
  });

  test("renders a blinking caret after the text by default", () => {
    seedTranscripts("hello");
    render(<VoiceLiveTranscript />);
    const caret = screen.getByTestId("voice-transcript-caret");
    expect(caret.getAttribute("aria-hidden")).toBe("true");
    expect(caret.className).toContain("voice-caret-blink");
  });
});

// ---------------------------------------------------------------------------
// Reduced-motion path — verified by stubbing `motion/react`.
// ---------------------------------------------------------------------------

describe("VoiceLiveTranscript — reduced motion", () => {
  afterEach(() => {
    mock.restore();
  });

  test("caret is static (no blink animation class) under reduced motion", async () => {
    mock.module("motion/react", () => ({
      useReducedMotion: () => true,
    }));

    const { VoiceLiveTranscript: ReducedTranscript } = await import(
      "./voice-live-transcript"
    );
    seedTranscripts("hello");
    render(<ReducedTranscript />);

    const caret = screen.getByTestId("voice-transcript-caret");
    // The caret stays visible as a static bar — only the blink is dropped.
    expect(caret.className).not.toContain("voice-caret-blink");
    expect(caret.className).toContain("bg-[var(--content-default)]");
  });
});
