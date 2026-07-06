/**
 * Tests for the live-voice store's session context and shared controls — the
 * seam that lets globally mounted surfaces (e.g. the title-bar session pill)
 * observe and drive a session owned by the composer's `useLiveVoice` instance.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import {
  useLiveVoiceStore,
  type LiveVoiceSessionControls,
} from "@/domains/chat/voice/live-voice/live-voice-store";

function makeControls(): LiveVoiceSessionControls {
  return { stop: mock(() => {}), release: mock(() => {}), interrupt: mock(() => {}) };
}

beforeEach(() => {
  useLiveVoiceStore.getState().reset();
});

describe("useLiveVoiceStore — session context", () => {
  test("defaults to null assistant/conversation when idle", () => {
    expect(useLiveVoiceStore.getState().assistantId).toBeNull();
    expect(useLiveVoiceStore.getState().conversationId).toBeNull();
  });

  test("setSessionContext records the owning assistant and conversation", () => {
    useLiveVoiceStore.getState().setSessionContext("assistant-1", "conv-1");
    expect(useLiveVoiceStore.getState().assistantId).toBe("assistant-1");
    expect(useLiveVoiceStore.getState().conversationId).toBe("conv-1");
  });

  test("setSessionContext accepts a null conversation", () => {
    useLiveVoiceStore.getState().setSessionContext("assistant-1", null);
    expect(useLiveVoiceStore.getState().assistantId).toBe("assistant-1");
    expect(useLiveVoiceStore.getState().conversationId).toBeNull();
  });

  test("reset clears the session context", () => {
    useLiveVoiceStore.getState().setSessionContext("assistant-1", "conv-1");
    useLiveVoiceStore.getState().reset();
    expect(useLiveVoiceStore.getState().assistantId).toBeNull();
    expect(useLiveVoiceStore.getState().conversationId).toBeNull();
  });
});

describe("useLiveVoiceStore — session controls", () => {
  test("defaults to null controls when idle", () => {
    expect(useLiveVoiceStore.getState().controls).toBeNull();
  });

  test("setControls registers the owning controller's controls", () => {
    const controls = makeControls();
    useLiveVoiceStore.getState().setControls(controls);
    expect(useLiveVoiceStore.getState().controls).toBe(controls);
  });

  test("setControls(null) deregisters controls", () => {
    useLiveVoiceStore.getState().setControls(makeControls());
    useLiveVoiceStore.getState().setControls(null);
    expect(useLiveVoiceStore.getState().controls).toBeNull();
  });

  test("reset clears registered controls", () => {
    useLiveVoiceStore.getState().setControls(makeControls());
    useLiveVoiceStore.getState().reset();
    expect(useLiveVoiceStore.getState().controls).toBeNull();
  });
});
