import { beforeEach, describe, expect, test } from "bun:test";

import { useVoicePrefsStore } from "@/stores/voice-prefs-store";

const VOICE_PREFS_STORE_KEY = "vellum:voice-prefs";

beforeEach(() => {
  localStorage.removeItem(VOICE_PREFS_STORE_KEY);
  useVoicePrefsStore.setState({
    showUserTranscript: false,
    showAssistantTranscript: false,
    firstRunSeen: false,
  });
});

describe("useVoicePrefsStore — voice-mode preferences", () => {
  test("defaults are all off", () => {
    expect(useVoicePrefsStore.getState().showUserTranscript).toBe(false);
    expect(useVoicePrefsStore.getState().showAssistantTranscript).toBe(false);
    expect(useVoicePrefsStore.getState().firstRunSeen).toBe(false);
  });

  test("setShowUserTranscript flips only the user-transcript field", () => {
    useVoicePrefsStore.getState().setShowUserTranscript(true);

    expect(useVoicePrefsStore.getState().showUserTranscript).toBe(true);
    expect(useVoicePrefsStore.getState().showAssistantTranscript).toBe(false);
    expect(useVoicePrefsStore.getState().firstRunSeen).toBe(false);

    useVoicePrefsStore.getState().setShowUserTranscript(false);
    expect(useVoicePrefsStore.getState().showUserTranscript).toBe(false);
  });

  test("setShowAssistantTranscript flips only the assistant-transcript field", () => {
    useVoicePrefsStore.getState().setShowAssistantTranscript(true);

    expect(useVoicePrefsStore.getState().showAssistantTranscript).toBe(true);
    expect(useVoicePrefsStore.getState().showUserTranscript).toBe(false);
    expect(useVoicePrefsStore.getState().firstRunSeen).toBe(false);

    useVoicePrefsStore.getState().setShowAssistantTranscript(false);
    expect(useVoicePrefsStore.getState().showAssistantTranscript).toBe(false);
  });

  test("markFirstRunSeen sets the flag", () => {
    useVoicePrefsStore.getState().markFirstRunSeen();
    expect(useVoicePrefsStore.getState().firstRunSeen).toBe(true);
  });

  test("markFirstRunSeen is idempotent and does not clobber later writes", () => {
    useVoicePrefsStore.getState().markFirstRunSeen();
    expect(useVoicePrefsStore.getState().firstRunSeen).toBe(true);

    // A subsequent unrelated write should survive a second markFirstRunSeen().
    useVoicePrefsStore.getState().setShowUserTranscript(true);
    useVoicePrefsStore.getState().markFirstRunSeen();

    expect(useVoicePrefsStore.getState().firstRunSeen).toBe(true);
    expect(useVoicePrefsStore.getState().showUserTranscript).toBe(true);
  });

  test("persists to the vellum:voice-prefs localStorage key", () => {
    useVoicePrefsStore.getState().setShowUserTranscript(true);
    useVoicePrefsStore.getState().setShowAssistantTranscript(true);
    useVoicePrefsStore.getState().markFirstRunSeen();

    const raw = localStorage.getItem(VOICE_PREFS_STORE_KEY);
    expect(raw).not.toBeNull();

    const persisted = JSON.parse(raw as string).state;
    expect(persisted.showUserTranscript).toBe(true);
    expect(persisted.showAssistantTranscript).toBe(true);
    expect(persisted.firstRunSeen).toBe(true);
  });
});
