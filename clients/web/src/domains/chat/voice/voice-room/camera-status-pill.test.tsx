/**
 * Tests for `CameraStatusPill`, the readout at the top of the room while the
 * camera is open, and for `useCameraStatusAnnouncement`, the sentence the room
 * speaks in its place.
 *
 * Load-bearing contracts: the dot's three voice states (which one blinks, and
 * that the assistant's takes the rose accent rather than white); that the word
 * is the session's own surface label for every phase, with the assistant's name
 * the only substitution; that the pill announces nothing itself, since a live
 * region arriving with its words already in it is announced by nothing
 * reliable; and the composed sentence, which is written prose rather than the
 * visible fragments, so a screen reader hears "Photo. Luna speaking" instead of
 * the pill's separator dot.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { cleanup, render, screen } from "@testing-library/react";

import { liveVoiceSurfaceLabelKey } from "@/domains/chat/voice/live-voice/live-voice-store";
import {
  CameraStatusPill,
  useCameraStatusAnnouncement,
  type CameraStatusAnnouncement,
} from "@/domains/chat/voice/voice-room/camera-status-pill";
import { fixedT } from "@/i18n";

afterEach(() => {
  cleanup();
});

/** The session's own surface label, resolved the way every surface resolves it. */
function surfaceLabel(
  state: Parameters<typeof liveVoiceSurfaceLabelKey>[0],
  reconnecting: boolean,
  assistantAudioActive: boolean,
  muted: boolean,
): string {
  const key = liveVoiceSurfaceLabelKey(
    state,
    reconnecting,
    assistantAudioActive,
    muted,
  );
  return key ? fixedT("chat")(key) : "";
}

const pill = () => screen.getByTestId("camera-status-pill");
const dot = () => screen.getByTestId("camera-status-dot");

/** The room's side of the split: the sentence, with no pill around it. */
function Announcer({ status }: { status: CameraStatusAnnouncement | null }) {
  return (
    <span data-testid="announcement">
      {useCameraStatusAnnouncement(status)}
    </span>
  );
}

function announce(status: CameraStatusAnnouncement | null): string {
  cleanup();
  render(<Announcer status={status} />);
  return screen.getByTestId("announcement").textContent ?? "";
}

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
  });

  test("the words are the session's surface label, not a second copy of it", () => {
    // A reconnect is the case a locally-written word would miss entirely: the
    // phase is still `connecting`, and only the shared helper relabels it.
    render(
      <CameraStatusPill
        voiceState="idle"
        statusLabel={surfaceLabel("connecting", true, false, false)}
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

    expect(pill().textContent).toBe("Photo");
    expect(pill().textContent).not.toContain("·");
  });

  test("announces nothing itself, and hides its fragments", () => {
    render(
      <CameraStatusPill
        voiceState="idle"
        statusLabel="Listening…"
        assistantName="Luna"
      />,
    );

    // A live region mounting with its first sentence already inside it is
    // announced unreliably, so the room owns the one that is always there and
    // this stays a drawing.
    expect(pill().getAttribute("role")).toBeNull();
    expect(pill().getAttribute("aria-live")).toBeNull();
    expect(pill().querySelector(".sr-only")).toBeNull();
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

  test("a long name gives way rather than running past the pill", () => {
    const long =
      "Marguerite Vandersteen of the Northern Reaches, Third of Her Name";
    render(
      <CameraStatusPill
        voiceState="assistant"
        statusLabel="Speaking…"
        assistantName={long}
      />,
    );

    // The room caps the pill; the pill takes that ceiling rather than the width
    // its one nowrap line would want.
    expect(pill().className).toContain("max-w-full");
    // The name is the only part that clips. The dot and "Photo" hold their size,
    // so the pill never reads as a bare ellipsis.
    const word = screen.getByTestId("camera-status-word");
    expect(word.className).toContain("truncate");
    expect(dot().className).toContain("flex-none");
    // A flex child only shrinks below its content when the row allows it.
    expect(pill().querySelector("[aria-hidden]")?.className).toContain(
      "min-w-0",
    );
  });

  test("photo is the mode it wears when the room names none", () => {
    render(
      <CameraStatusPill
        voiceState="idle"
        statusLabel="Listening…"
        assistantName="Luna"
      />,
    );

    expect(pill().dataset.cameraMode).toBe("photo");
    // Glass, so the frame reads through a mark that is only sampling it.
    expect(pill().className).toContain("bg-[rgba(0,0,0,0.34)]");
    expect(pill().className).toContain("backdrop-blur-[8px]");
  });

  test("live fills with the capture accent and says so", () => {
    render(
      <CameraStatusPill
        mode="live"
        voiceState="idle"
        statusLabel="Listening…"
        assistantName="Luna"
      />,
    );

    expect(pill().dataset.cameraMode).toBe("live");
    expect(pill().textContent).toContain("Live");
    expect(pill().textContent).not.toContain("Photo");
    // Filled rather than glass: "this is going out continuously" has to be
    // legible without reading.
    expect(pill().className).toContain("bg-[var(--camera-accent-fill)]");
    expect(pill().className).toContain("border-[rgba(255,255,255,0.25)]");
    expect(pill().className).toContain("text-white");
    // The accent the fill names is published by the pill itself, so a renamed
    // constant surfaces here rather than as a transparent chip.
    expect(pill().getAttribute("style")).toContain("--camera-accent-fill");
  });
});

describe("useCameraStatusAnnouncement", () => {
  test("says nothing at all while the camera is closed", () => {
    // The empty string rather than an unmounted region: assistive tech
    // announces a change made inside a region it was already watching.
    expect(announce(null)).toBe("");
  });

  test("leads with the mode and closes with the session's own word", () => {
    expect(
      announce({
        voiceState: "idle",
        statusLabel: "Listening…",
        assistantName: "Luna",
      }),
    ).toBe("Photo. Listening…");
  });

  test("a talking user changes the dot, not the sentence", () => {
    // The word answers "can she hear me", which is unchanged by the user
    // talking; the dot is what says a voice is live.
    expect(
      announce({
        voiceState: "user",
        statusLabel: "Listening…",
        assistantName: "Luna",
      }),
    ).toBe("Photo. Listening…");
  });

  test("names the assistant while it is the one talking", () => {
    expect(
      announce({
        voiceState: "assistant",
        statusLabel: "Speaking…",
        assistantName: "Luna",
      }),
    ).toBe("Photo. Luna speaking");
  });

  test("an unresolved assistant falls back rather than naming nobody", () => {
    expect(
      announce({
        voiceState: "assistant",
        statusLabel: "Speaking…",
        assistantName: null,
      }),
    ).toBe("Photo. Your assistant speaking");
  });

  test("a muted mic reaches the sentence in a phase that never says so", () => {
    // The session does not relabel its own phases for mute, and this is the
    // room's only announcement while the viewfinder is up, so "Thinking…"
    // alone would leave a screen-reader user unaware the mic is off.
    expect(
      announce({
        voiceState: "idle",
        statusLabel: "Thinking…",
        assistantName: "Luna",
        muted: true,
      }),
    ).toBe("Photo. Muted. Thinking…");
  });

  test("a muted mic reaches the sentence while the assistant talks", () => {
    expect(
      announce({
        voiceState: "assistant",
        statusLabel: "Speaking…",
        assistantName: "Luna",
        muted: true,
      }),
    ).toBe("Photo. Muted. Luna speaking");
  });

  test("does not say muted twice when the word already says it", () => {
    expect(
      announce({
        voiceState: "idle",
        statusLabel: "Muted",
        assistantName: "Luna",
        muted: true,
      }),
    ).toBe("Photo. Muted");
  });

  test("an unmuted phase announces exactly what it did", () => {
    expect(
      announce({
        voiceState: "idle",
        statusLabel: "Thinking…",
        assistantName: "Luna",
        muted: false,
      }),
    ).toBe("Photo. Thinking…");
  });

  test("a muted mic with no phase word left still says the mic is off", () => {
    expect(
      announce({
        voiceState: "idle",
        statusLabel: "",
        assistantName: "Luna",
        muted: true,
      }),
    ).toBe("Photo. Muted");
  });

  test("a phase with no label leaves the mode word standing alone", () => {
    expect(
      announce({
        voiceState: "idle",
        statusLabel: "",
        assistantName: "Luna",
      }),
    ).toBe("Photo");
  });

  test("a long name stays whole, since a screen reader has no width", () => {
    const long =
      "Marguerite Vandersteen of the Northern Reaches, Third of Her Name";

    expect(
      announce({
        voiceState: "assistant",
        statusLabel: "Speaking…",
        assistantName: long,
      }),
    ).toBe(`Photo. ${long} speaking`);
  });

  test("the live mode opens the same sentence with its own word", () => {
    expect(
      announce({
        mode: "live",
        voiceState: "idle",
        statusLabel: "Listening…",
        assistantName: "Luna",
      }),
    ).toBe("Live. Listening…");
    expect(
      announce({
        mode: "live",
        voiceState: "assistant",
        statusLabel: "Speaking…",
        assistantName: "Luna",
        muted: true,
      }),
    ).toBe("Live. Muted. Luna speaking");
  });
});
