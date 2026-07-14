import { beforeEach, describe, expect, test } from "bun:test";

import {
  DEFAULT_INTERRUPT_SENSITIVITY,
  DEFAULT_PAUSE_BEFORE_REPLY_MS,
  MAX_PAUSE_BEFORE_REPLY_MS,
  MIN_PAUSE_BEFORE_REPLY_MS,
  interruptSensitivityToMs,
  useVoicePrefsStore,
} from "@/stores/voice-prefs-store";

const VOICE_PREFS_STORE_KEY = "vellum:voice-prefs";

beforeEach(() => {
  localStorage.removeItem(VOICE_PREFS_STORE_KEY);
  useVoicePrefsStore.setState({
    showUserTranscript: false,
    showAssistantTranscript: false,
    firstRunSeen: false,
    pauseBeforeReplyMs: DEFAULT_PAUSE_BEFORE_REPLY_MS,
    interruptSensitivity: DEFAULT_INTERRUPT_SENSITIVITY,
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
    useVoicePrefsStore.getState().setPauseBeforeReplyMs(1500);
    useVoicePrefsStore.getState().setInterruptSensitivity("low");

    const raw = localStorage.getItem(VOICE_PREFS_STORE_KEY);
    expect(raw).not.toBeNull();

    const persisted = JSON.parse(raw as string).state;
    expect(persisted.showUserTranscript).toBe(true);
    expect(persisted.showAssistantTranscript).toBe(true);
    expect(persisted.firstRunSeen).toBe(true);
    expect(persisted.pauseBeforeReplyMs).toBe(1500);
    expect(persisted.interruptSensitivity).toBe("low");
  });
});

describe("useVoicePrefsStore — turn-taking settings (JARVIS-1284)", () => {
  test("defaults: 1200 ms pause, medium sensitivity", () => {
    expect(useVoicePrefsStore.getState().pauseBeforeReplyMs).toBe(1200);
    expect(useVoicePrefsStore.getState().interruptSensitivity).toBe("medium");
    expect(DEFAULT_PAUSE_BEFORE_REPLY_MS).toBe(1200);
  });

  test("setInterruptSensitivity records the level", () => {
    useVoicePrefsStore.getState().setInterruptSensitivity("high");
    expect(useVoicePrefsStore.getState().interruptSensitivity).toBe("high");
  });

  test("interruptSensitivityToMs maps inversely (higher sensitivity → fewer ms)", () => {
    expect(interruptSensitivityToMs("high")).toBe(100);
    expect(interruptSensitivityToMs("medium")).toBe(250);
    expect(interruptSensitivityToMs("low")).toBe(600);
  });

  test("setPauseBeforeReplyMs clamps to the supported range and rounds", () => {
    const set = useVoicePrefsStore.getState().setPauseBeforeReplyMs;

    set(1234.6);
    expect(useVoicePrefsStore.getState().pauseBeforeReplyMs).toBe(1235);

    set(50); // below MIN
    expect(useVoicePrefsStore.getState().pauseBeforeReplyMs).toBe(
      MIN_PAUSE_BEFORE_REPLY_MS,
    );

    set(99_999); // above MAX
    expect(useVoicePrefsStore.getState().pauseBeforeReplyMs).toBe(
      MAX_PAUSE_BEFORE_REPLY_MS,
    );

    set(Number.NaN); // guards against non-finite
    expect(useVoicePrefsStore.getState().pauseBeforeReplyMs).toBe(
      DEFAULT_PAUSE_BEFORE_REPLY_MS,
    );
  });
});
