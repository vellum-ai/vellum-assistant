/**
 * Tests for `CameraStatusPill`, the readout at the top of the room while the
 * camera is open.
 *
 * Load-bearing contracts: the dot's three voice states (which one blinks, and
 * that the assistant's takes the rose accent rather than white); the word the
 * mic's mute state replaces, and that it does NOT replace the assistant's name;
 * and the announcement, which is a written sentence rather than the visible
 * fragments, so a screen reader hears "Photo. Luna speaking" instead of the
 * pill's separator dot.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { cleanup, render, screen } from "@testing-library/react";

import { CameraStatusPill } from "@/domains/chat/voice/voice-room/camera-status-pill";

afterEach(() => {
  cleanup();
});

const pill = () => screen.getByTestId("camera-status-pill");
const dot = () => screen.getByTestId("camera-status-dot");
/** What a screen reader is handed: the sr-only sentence, not the fragments. */
const announcement = () => pill().querySelector(".sr-only")?.textContent ?? "";

describe("CameraStatusPill", () => {
  test("idle holds the dot still and says the session is still listening", () => {
    render(<CameraStatusPill voiceState="idle" assistantName="Luna" />);

    expect(dot().className).toContain("bg-white/50");
    expect(dot().className).not.toContain("camera-status-blink");
    expect(pill().textContent).toContain("Listening");
    expect(announcement()).toBe("Photo. Listening");
  });

  test("a talking user blinks a white dot beside the same word", () => {
    render(<CameraStatusPill voiceState="user" assistantName="Luna" />);

    expect(dot().className).toContain("bg-white");
    expect(dot().className).toContain("camera-status-blink");
    // The word answers "can she hear me", which is unchanged by the user
    // talking; the dot is what says a voice is live.
    expect(announcement()).toBe("Photo. Listening");
  });

  test("the assistant takes the rose accent and its own name", () => {
    render(<CameraStatusPill voiceState="assistant" assistantName="Luna" />);

    expect(dot().className).toContain("bg-[var(--camera-accent-soft)]");
    expect(dot().className).toContain("camera-status-blink");
    expect(pill().textContent).toContain("Luna");
    expect(announcement()).toBe("Photo. Luna speaking");
  });

  test("an unresolved assistant falls back rather than naming nobody", () => {
    render(<CameraStatusPill voiceState="assistant" assistantName={null} />);

    expect(pill().textContent).toContain("your assistant");
    expect(announcement()).toBe("Photo. your assistant speaking");
  });

  test("a muted mic replaces the listening word, in both channels", () => {
    render(<CameraStatusPill voiceState="idle" muted assistantName="Luna" />);

    expect(pill().textContent).toContain("Muted");
    expect(pill().textContent).not.toContain("Listening");
    expect(announcement()).toBe("Photo. Muted");
  });

  test("muting does not silence the assistant's half of the readout", () => {
    // Muting the mic stops her hearing you; it does not stop her talking, so
    // the word still has to be her name.
    render(
      <CameraStatusPill voiceState="assistant" muted assistantName="Luna" />,
    );

    expect(pill().textContent).toContain("Luna");
    expect(announcement()).toBe("Photo. Luna speaking");
  });

  test("announces as a polite status, with the visible fragments hidden", () => {
    render(<CameraStatusPill voiceState="idle" assistantName="Luna" />);

    expect(pill().getAttribute("role")).toBe("status");
    expect(pill().getAttribute("aria-live")).toBe("polite");
    // Reading the row itself would announce the separator and drop the verb.
    const row = pill().querySelector("[aria-hidden]");
    expect(row).not.toBeNull();
    expect(row?.textContent).toContain("·");
  });

  test("holds a floor width so the word swap does not shuffle the pill", () => {
    render(<CameraStatusPill voiceState="idle" assistantName="Luna" />);

    expect(pill().className).toContain("min-w-");
    expect(pill().querySelector("[aria-hidden]")?.className).toContain(
      "whitespace-nowrap",
    );
  });
});
