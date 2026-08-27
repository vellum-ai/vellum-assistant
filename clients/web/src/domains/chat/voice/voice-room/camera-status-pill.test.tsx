/**
 * Tests for `CameraStatusPill`, the readout at the top of the room while the
 * camera is open.
 *
 * Load-bearing contracts: the dot's three voice states (which one blinks, and
 * that the assistant's takes the rose accent rather than white); that the word
 * is the session's own surface label for every phase, with the assistant's name
 * the only substitution; and the announcement, which is a written sentence
 * rather than the visible fragments, so a screen reader hears "Photo. Luna
 * speaking" instead of the pill's separator dot.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { cleanup, render, screen } from "@testing-library/react";

import { liveVoiceSurfaceLabel } from "@/domains/chat/voice/live-voice/live-voice-store";
import { CameraStatusPill } from "@/domains/chat/voice/voice-room/camera-status-pill";

afterEach(() => {
  cleanup();
});

const pill = () => screen.getByTestId("camera-status-pill");
const dot = () => screen.getByTestId("camera-status-dot");
/** What a screen reader is handed: the sr-only sentence, not the fragments. */
const announcement = () => pill().querySelector(".sr-only")?.textContent ?? "";

describe("CameraStatusPill", () => {
  test("idle holds the dot still and repeats the session's own word", () => {
    render(
      <CameraStatusPill
        voiceState="idle"
        statusLabel="Listening…"
        assistantName="Luna"
      />,
    );

    expect(dot().className).toContain("bg-white/50");
    expect(dot().className).not.toContain("camera-status-blink");
    expect(pill().textContent).toContain("Listening…");
    expect(announcement()).toBe("Photo. Listening…");
  });

  test("a talking user blinks a white dot beside the same word", () => {
    render(
      <CameraStatusPill
        voiceState="user"
        statusLabel="Listening…"
        assistantName="Luna"
      />,
    );

    expect(dot().className).toContain("bg-white");
    expect(dot().className).toContain("camera-status-blink");
    // The word answers "can she hear me", which is unchanged by the user
    // talking; the dot is what says a voice is live.
    expect(announcement()).toBe("Photo. Listening…");
  });

  test("the assistant takes the rose accent and its own name", () => {
    render(
      <CameraStatusPill
        voiceState="assistant"
        statusLabel="Speaking…"
        assistantName="Luna"
      />,
    );

    expect(dot().className).toContain("bg-[var(--camera-accent-soft)]");
    expect(dot().className).toContain("camera-status-blink");
    expect(pill().textContent).toContain("Luna");
    // The name is the whole substitution: it says what "Speaking…" would, plus
    // whose voice it is.
    expect(pill().textContent).not.toContain("Speaking…");
    expect(announcement()).toBe("Photo. Luna speaking");
  });

  test("an unresolved assistant falls back rather than naming nobody", () => {
    render(
      <CameraStatusPill
        voiceState="assistant"
        statusLabel="Speaking…"
        assistantName={null}
      />,
    );

    // Translated copy, not the English fallback in `assistantDisplayName`: the
    // name lands inside a sentence this catalog owns.
    expect(pill().textContent).toContain("Your assistant");
    expect(announcement()).toBe("Photo. Your assistant speaking");
  });

  test("a blank name falls back the same way a missing one does", () => {
    render(
      <CameraStatusPill
        voiceState="assistant"
        statusLabel="Speaking…"
        assistantName="   "
      />,
    );

    expect(pill().textContent).toContain("Your assistant");
  });

  test("a muted mic replaces the listening word, in both channels", () => {
    render(
      <CameraStatusPill
        voiceState="idle"
        statusLabel="Muted"
        assistantName="Luna"
      />,
    );

    expect(pill().textContent).toContain("Muted");
    expect(pill().textContent).not.toContain("Listening");
    expect(announcement()).toBe("Photo. Muted");
  });

  test("a connecting session says so instead of claiming to listen", () => {
    render(
      <CameraStatusPill
        voiceState="idle"
        statusLabel="Connecting…"
        assistantName="Luna"
      />,
    );

    expect(pill().textContent).toContain("Connecting…");
    expect(pill().textContent).not.toContain("Listening");
    expect(dot().className).not.toContain("camera-status-blink");
    expect(announcement()).toBe("Photo. Connecting…");
  });

  test("a thinking session says so instead of claiming to listen", () => {
    render(
      <CameraStatusPill
        voiceState="idle"
        statusLabel="Thinking…"
        assistantName="Luna"
      />,
    );

    expect(pill().textContent).toContain("Thinking…");
    expect(pill().textContent).not.toContain("Listening");
    expect(announcement()).toBe("Photo. Thinking…");
  });

  test("an ending session says so instead of claiming to listen", () => {
    render(
      <CameraStatusPill
        voiceState="idle"
        statusLabel="Ending…"
        assistantName="Luna"
      />,
    );

    expect(pill().textContent).toContain("Ending…");
    expect(announcement()).toBe("Photo. Ending…");
  });

  test("the words are the session's surface label, not a second copy of it", () => {
    // A reconnect is the case a locally-written word would miss entirely: the
    // phase is still `connecting`, and only the shared helper relabels it.
    render(
      <CameraStatusPill
        voiceState="idle"
        statusLabel={liveVoiceSurfaceLabel("connecting", true, false, false)}
        assistantName="Luna"
      />,
    );

    expect(pill().textContent).toContain("Reconnecting…");
  });

  test("a phase with no label drops the word rather than inventing one", () => {
    // `idle` and `failed` carry an empty label. A dangling separator with
    // nothing after it would read as a truncated sentence.
    render(
      <CameraStatusPill
        voiceState="idle"
        statusLabel=""
        assistantName="Luna"
      />,
    );

    expect(pill().textContent).toBe("PhotoPhoto");
    expect(pill().textContent).not.toContain("·");
    expect(announcement()).toBe("Photo");
  });

  test("announces as a polite status, with the visible fragments hidden", () => {
    render(
      <CameraStatusPill
        voiceState="idle"
        statusLabel="Listening…"
        assistantName="Luna"
      />,
    );

    expect(pill().getAttribute("role")).toBe("status");
    expect(pill().getAttribute("aria-live")).toBe("polite");
    // Reading the row itself would announce the separator and drop the verb.
    const row = pill().querySelector("[aria-hidden]");
    expect(row).not.toBeNull();
    expect(row?.textContent).toContain("·");
  });

  test("holds a floor width so the word swap does not shuffle the pill", () => {
    render(
      <CameraStatusPill
        voiceState="idle"
        statusLabel="Listening…"
        assistantName="Luna"
      />,
    );

    expect(pill().className).toContain("min-w-");
    expect(pill().querySelector("[aria-hidden]")?.className).toContain(
      "whitespace-nowrap",
    );
  });
});
