/**
 * Tests for `VoiceAmbientTranscript`.
 *
 * Both source stores are self-contained zustand, so tests drive the real
 * stores (as `voice-live-transcript.test.tsx` does) rather than mocking
 * selectors: transcript fields via the live-voice store, the two visibility
 * toggles via the voice-prefs store. The load-bearing contract is the
 * pref-gating — both prefs default OFF, so the room stays text-free — plus the
 * user-before-assistant DOM ordering. The spoken-word cursor block additionally
 * drives frames through the shared rAF harness (`raf.test-helper.ts`) and
 * playback progress through the store's provider, asserting the leading tone
 * via the `data-leading` attribute on word spans.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { act, cleanup, render, screen } from "@testing-library/react";

import {
  type LiveVoiceSessionState,
  useLiveVoiceStore,
} from "@/domains/chat/voice/live-voice/live-voice-store";
import type { LiveVoicePlaybackProgress } from "@/domains/chat/voice/live-voice/tts-playback";
import {
  installRafTestHarness,
  type RafTestHarness,
} from "@/domains/chat/voice/raf.test-helper";
import { useVoicePrefsStore } from "@/stores/voice-prefs-store";

import { VoiceAmbientTranscript } from "@/domains/chat/voice/voice-room/voice-ambient-transcript";

function seedUser(partial: string, final = "") {
  act(() => {
    useLiveVoiceStore.getState().setPartialTranscript(partial);
    useLiveVoiceStore.getState().setFinalTranscript(final);
  });
}

function seedAssistant(text: string) {
  act(() => {
    useLiveVoiceStore.getState().clearAssistantTranscript();
    useLiveVoiceStore.getState().appendAssistantTranscript(text);
  });
}

function setPrefs({ user, assistant }: { user: boolean; assistant: boolean }) {
  act(() => {
    useVoicePrefsStore.getState().setShowUserTranscript(user);
    useVoicePrefsStore.getState().setShowAssistantTranscript(assistant);
  });
}

function setSessionState(state: LiveVoiceSessionState) {
  act(() => {
    useLiveVoiceStore.getState().setState(state);
  });
}

const userText = () => screen.queryByTestId("voice-ambient-user");
const assistantText = () => screen.queryByTestId("voice-ambient-assistant");

beforeEach(() => {
  useLiveVoiceStore.getState().reset();
  // Prefs default OFF; force the known default in case a prior file leaked.
  setPrefs({ user: false, assistant: false });
});

afterEach(() => {
  cleanup();
  useLiveVoiceStore.getState().reset();
  setPrefs({ user: false, assistant: false });
});

describe("VoiceAmbientTranscript — pref gating", () => {
  test("renders nothing when both prefs are OFF (the default)", () => {
    seedUser("hello there");
    seedAssistant("hi, how can I help");
    const { container } = render(<VoiceAmbientTranscript />);
    expect(container.innerHTML).toBe("");
    expect(userText()).toBeNull();
    expect(assistantText()).toBeNull();
  });

  test("shows the user text only when showUserTranscript is ON", () => {
    seedUser("hello there");
    seedAssistant("hi, how can I help");
    setPrefs({ user: true, assistant: false });
    render(<VoiceAmbientTranscript />);
    expect(userText()?.textContent).toContain("hello there");
    expect(assistantText()).toBeNull();
  });

  test("shows the assistant text only when showAssistantTranscript is ON", () => {
    seedUser("hello there");
    seedAssistant("hi, how can I help");
    setPrefs({ user: false, assistant: true });
    render(<VoiceAmbientTranscript />);
    expect(assistantText()?.textContent).toContain("hi, how can I help");
    expect(userText()).toBeNull();
  });

  test("renders nothing while a pref is ON but its transcript is empty", () => {
    setPrefs({ user: true, assistant: true });
    const { container } = render(<VoiceAmbientTranscript />);
    expect(container.innerHTML).toBe("");
  });
});

describe("VoiceAmbientTranscript — listening gate", () => {
  test("hides the lingering assistant transcript while listening", () => {
    // A finished response lingers in the store until the next turn thinks; the
    // following `listening` turn must not paint it under the low-sunk eyes.
    seedAssistant("my previous answer");
    setPrefs({ user: false, assistant: true });
    setSessionState("listening");
    render(<VoiceAmbientTranscript />);
    expect(assistantText()).toBeNull();
  });

  test("shows the assistant transcript while the assistant is speaking", () => {
    seedAssistant("here's my answer");
    setPrefs({ user: false, assistant: true });
    setSessionState("speaking");
    render(<VoiceAmbientTranscript />);
    expect(assistantText()?.textContent).toContain("here's my answer");
  });

  test("still shows the user transcript while listening", () => {
    seedUser("what I'm saying now");
    setPrefs({ user: true, assistant: false });
    setSessionState("listening");
    render(<VoiceAmbientTranscript />);
    expect(userText()?.textContent).toContain("what I'm saying now");
  });
});

describe("VoiceAmbientTranscript — sourcing and ordering", () => {
  test("user half prefers the in-flight partial over the last final", () => {
    seedUser("still speaking", "previous final");
    setPrefs({ user: true, assistant: false });
    render(<VoiceAmbientTranscript />);
    expect(userText()?.textContent).toContain("still speaking");
    expect(userText()?.textContent).not.toContain("previous final");
  });

  test("user half falls back to the final transcript when no partial is in flight", () => {
    seedUser("", "what I said");
    setPrefs({ user: true, assistant: false });
    render(<VoiceAmbientTranscript />);
    expect(userText()?.textContent).toContain("what I said");
  });

  test("renders user before assistant in DOM order when both are ON", () => {
    seedUser("my question");
    seedAssistant("my answer");
    setPrefs({ user: true, assistant: true });
    render(<VoiceAmbientTranscript />);
    const user = userText();
    const assistant = assistantText();
    expect(user).not.toBeNull();
    expect(assistant).not.toBeNull();
    // User node precedes the assistant node in document order.
    expect(
      user!.compareDocumentPosition(assistant!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  test("user half renders a bubble tied to the room bubble-bg var", () => {
    seedUser("hello there");
    setPrefs({ user: true, assistant: false });
    render(<VoiceAmbientTranscript />);
    const bubble = screen.queryByTestId("voice-ambient-user-bubble");
    expect(bubble).not.toBeNull();
    expect(bubble!.getAttribute("style")).toContain("--room-bubble-bg");
  });

  test("assistant half is plain text with no bubble wrapper", () => {
    seedAssistant("my answer");
    setPrefs({ user: false, assistant: true });
    render(<VoiceAmbientTranscript />);
    expect(screen.queryByTestId("voice-ambient-user-bubble")).toBeNull();
    expect(assistantText()?.textContent).toContain("my answer");
  });

  test("streams assistant deltas without remounting", () => {
    seedAssistant("Hel");
    setPrefs({ user: false, assistant: true });
    render(<VoiceAmbientTranscript />);
    act(() => {
      useLiveVoiceStore.getState().appendAssistantTranscript("lo world");
    });
    expect(assistantText()?.textContent).toContain("Hello world");
  });
});

describe("VoiceAmbientTranscript — spoken-word cursor", () => {
  let raf: RafTestHarness;
  let progress: LiveVoicePlaybackProgress | null;

  /** Text of the word span carrying the bright leading-edge tone. */
  function leadingWordIn(half: HTMLElement) {
    return half.querySelector("[data-leading]")?.textContent;
  }

  function registerProgressProvider() {
    act(() => {
      useLiveVoiceStore.getState().setPlaybackProgressProvider(() => progress);
    });
  }

  beforeEach(() => {
    raf = installRafTestHarness();
    progress = null;
  });

  afterEach(() => {
    cleanup();
    raf.restore();
  });

  test("highlight sits on the mid-transcript word at playback fraction 0.5", () => {
    progress = { playedSeconds: 5, totalSeconds: 10 };
    registerProgressProvider();
    seedAssistant("alpha beta gamma delta");
    setPrefs({ user: false, assistant: true });
    render(<VoiceAmbientTranscript />);
    raf.pumpFrame();
    // floor(0.5 * 4 words) = index 2 — mid-transcript, not the last word.
    expect(leadingWordIn(assistantText()!)).toBe("gamma");
  });

  test("a first read that is already drained keeps the default last-word edge", () => {
    // The response's audio finished before the cursor loop ever observed a
    // sub-total frame: the rail keeps the default reveal, not a pinned first
    // word.
    progress = { playedSeconds: 3, totalSeconds: 3 };
    registerProgressProvider();
    seedAssistant("alpha beta gamma delta");
    setPrefs({ user: false, assistant: true });
    render(<VoiceAmbientTranscript />);
    raf.pumpFrame();
    raf.pumpFrame();
    expect(leadingWordIn(assistantText()!)).toBe("delta");
  });

  test("schedules no frames while assistant captions are off", () => {
    registerProgressProvider();
    seedAssistant("alpha beta gamma delta");
    setPrefs({ user: false, assistant: false });
    render(<VoiceAmbientTranscript />);
    expect(raf.requestCount()).toBe(0);
    expect(raf.pendingCallbacks()).toHaveLength(0);
  });

  test("no registered provider keeps the default last-word leading edge", () => {
    seedAssistant("alpha beta gamma delta");
    setPrefs({ user: false, assistant: true });
    render(<VoiceAmbientTranscript />);
    raf.pumpFrame();
    expect(leadingWordIn(assistantText()!)).toBe("delta");
  });

  test("cursor takes over from the default reveal once playback progress arrives", () => {
    registerProgressProvider();
    seedAssistant("alpha beta gamma delta");
    setPrefs({ user: false, assistant: true });
    render(<VoiceAmbientTranscript />);
    raf.pumpFrame();
    // No audio yet: default reveal, the newest word leads.
    expect(leadingWordIn(assistantText()!)).toBe("delta");

    progress = { playedSeconds: 5, totalSeconds: 10 };
    raf.pumpFrame();
    expect(leadingWordIn(assistantText()!)).toBe("gamma");
  });

  test("new response reverts to the default reveal until its own audio starts", () => {
    progress = { playedSeconds: 5, totalSeconds: 10 };
    registerProgressProvider();
    seedAssistant("alpha beta gamma delta");
    setPrefs({ user: false, assistant: true });
    render(<VoiceAmbientTranscript />);
    raf.pumpFrame();
    expect(leadingWordIn(assistantText()!)).toBe("gamma");

    // Next response: the transcript clears (shorter word list), no audio yet.
    progress = null;
    seedAssistant("fresh words");
    raf.pumpFrame();
    expect(leadingWordIn(assistantText()!)).toBe("words");

    progress = { playedSeconds: 1, totalSeconds: 4 };
    raf.pumpFrame();
    // floor(0.25 * 2 words) = index 0 — the cursor is live again.
    expect(leadingWordIn(assistantText()!)).toBe("fresh");
  });

  test("user bubble keeps its default last-word leading edge", () => {
    progress = { playedSeconds: 5, totalSeconds: 10 };
    registerProgressProvider();
    seedUser("one two three four");
    setPrefs({ user: true, assistant: false });
    render(<VoiceAmbientTranscript />);
    raf.pumpFrame();
    expect(leadingWordIn(userText()!)).toBe("four");
  });
});
