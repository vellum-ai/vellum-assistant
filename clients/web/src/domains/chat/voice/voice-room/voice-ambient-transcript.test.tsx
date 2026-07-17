/**
 * Tests for `VoiceAmbientTranscript`.
 *
 * Both source stores are self-contained zustand, so tests drive the real
 * stores (as `voice-live-transcript.test.tsx` does) rather than mocking
 * selectors: transcript fields via the live-voice store, the two visibility
 * toggles via the voice-prefs store. The load-bearing contract is the
 * pref-gating — both prefs default OFF, so the room stays text-free — plus the
 * user-above / assistant-below ordering.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { act, cleanup, render, screen } from "@testing-library/react";

import {
  type LiveVoiceSessionState,
  useLiveVoiceStore,
} from "@/domains/chat/voice/live-voice/live-voice-store";
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

  test("shows the user text (above) only when showUserTranscript is ON", () => {
    seedUser("hello there");
    seedAssistant("hi, how can I help");
    setPrefs({ user: true, assistant: false });
    render(<VoiceAmbientTranscript />);
    expect(userText()?.textContent).toContain("hello there");
    expect(assistantText()).toBeNull();
  });

  test("shows the assistant text (below) only when showAssistantTranscript is ON", () => {
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

  test("renders user ABOVE assistant (DOM order) when both are ON", () => {
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
