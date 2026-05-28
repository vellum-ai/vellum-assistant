import { afterEach, describe, expect, test } from "bun:test";

import type { LiveVoiceStoreState } from "@/domains/voice/live-voice/live-voice-store";
import { useLiveVoiceStore } from "@/domains/voice/live-voice/live-voice-store";

function resetStore() {
  useLiveVoiceStore.getState().reset();
}

afterEach(() => {
  resetStore();
});

describe("LiveVoiceStore", () => {
  test("defaults to the off state with empty session info", () => {
    const state = useLiveVoiceStore.getState();
    expect(state.state).toBe("off");
    expect(state.sessionId).toBeNull();
    expect(state.conversationId).toBeNull();
    expect(state.partialTranscript).toBe("");
    expect(state.finalTranscript).toBe("");
    expect(state.assistantTranscript).toBe("");
    expect(state.inputAmplitude).toBe(0);
    expect(state.errorMessage).toBe("");
  });

  test("setState transitions through each lifecycle phase", () => {
    const phases = [
      "connecting",
      "listening",
      "transcribing",
      "thinking",
      "speaking",
      "ending",
      "failed",
      "off",
    ] as const;

    for (const phase of phases) {
      useLiveVoiceStore.getState().setState(phase);
      expect(useLiveVoiceStore.getState().state).toBe(phase);
    }
  });

  test("setSessionInfo updates both session and conversation ids", () => {
    useLiveVoiceStore.getState().setSessionInfo({
      sessionId: "sess-1",
      conversationId: "conv-1",
    });

    let state = useLiveVoiceStore.getState();
    expect(state.sessionId).toBe("sess-1");
    expect(state.conversationId).toBe("conv-1");

    useLiveVoiceStore.getState().setSessionInfo({
      sessionId: null,
      conversationId: null,
    });

    state = useLiveVoiceStore.getState();
    expect(state.sessionId).toBeNull();
    expect(state.conversationId).toBeNull();
  });

  test("setPartialTranscript replaces the partial transcript", () => {
    useLiveVoiceStore.getState().setPartialTranscript("hello");
    expect(useLiveVoiceStore.getState().partialTranscript).toBe("hello");

    useLiveVoiceStore.getState().setPartialTranscript("hello world");
    expect(useLiveVoiceStore.getState().partialTranscript).toBe("hello world");

    useLiveVoiceStore.getState().setPartialTranscript("");
    expect(useLiveVoiceStore.getState().partialTranscript).toBe("");
  });

  test("setFinalTranscript replaces the final transcript", () => {
    useLiveVoiceStore.getState().setFinalTranscript("done");
    expect(useLiveVoiceStore.getState().finalTranscript).toBe("done");

    useLiveVoiceStore.getState().setFinalTranscript("done again");
    expect(useLiveVoiceStore.getState().finalTranscript).toBe("done again");
  });

  test("appendAssistantTranscript concatenates streamed deltas", () => {
    useLiveVoiceStore.getState().appendAssistantTranscript("hello");
    useLiveVoiceStore.getState().appendAssistantTranscript(" ");
    useLiveVoiceStore.getState().appendAssistantTranscript("world");

    expect(useLiveVoiceStore.getState().assistantTranscript).toBe(
      "hello world",
    );
  });

  test("clearAssistantTranscript wipes the accumulated transcript", () => {
    useLiveVoiceStore.getState().appendAssistantTranscript("hello");
    useLiveVoiceStore.getState().appendAssistantTranscript(" world");
    useLiveVoiceStore.getState().clearAssistantTranscript();

    expect(useLiveVoiceStore.getState().assistantTranscript).toBe("");
  });

  test("setInputAmplitude updates the amplitude", () => {
    useLiveVoiceStore.getState().setInputAmplitude(0.42);
    expect(useLiveVoiceStore.getState().inputAmplitude).toBe(0.42);

    useLiveVoiceStore.getState().setInputAmplitude(0);
    expect(useLiveVoiceStore.getState().inputAmplitude).toBe(0);
  });

  test("setError records the error message", () => {
    useLiveVoiceStore.getState().setError("mic permission denied");
    expect(useLiveVoiceStore.getState().errorMessage).toBe(
      "mic permission denied",
    );

    useLiveVoiceStore.getState().setError("");
    expect(useLiveVoiceStore.getState().errorMessage).toBe("");
  });

  test("reset returns the store to its initial state", () => {
    const actions = useLiveVoiceStore.getState();
    actions.setState("listening");
    actions.setSessionInfo({
      sessionId: "sess-1",
      conversationId: "conv-1",
    });
    actions.setPartialTranscript("partial");
    actions.setFinalTranscript("final");
    actions.appendAssistantTranscript("assistant");
    actions.setInputAmplitude(0.5);
    actions.setError("boom");

    actions.reset();

    const state = useLiveVoiceStore.getState();
    expect(state.state).toBe("off");
    expect(state.sessionId).toBeNull();
    expect(state.conversationId).toBeNull();
    expect(state.partialTranscript).toBe("");
    expect(state.finalTranscript).toBe("");
    expect(state.assistantTranscript).toBe("");
    expect(state.inputAmplitude).toBe(0);
    expect(state.errorMessage).toBe("");
  });

  test("createSelectors exposes a per-field hook for every state field", () => {
    // The atomic-selector contract: every state field gets its own
    // `use.<field>()` hook, so consumers can subscribe to one slice
    // without re-rendering on unrelated mutations.
    const expectedFields: ReadonlyArray<keyof typeof useLiveVoiceStore.use> = [
      "state",
      "sessionId",
      "conversationId",
      "partialTranscript",
      "finalTranscript",
      "assistantTranscript",
      "inputAmplitude",
      "errorMessage",
    ];

    for (const field of expectedFields) {
      expect(typeof useLiveVoiceStore.use[field]).toBe("function");
    }
  });

  test("state shape uses only primitive fields (no nested objects)", () => {
    // createSelectors compares field references with ===; nested
    // objects would break that contract by producing new references
    // on every set(). This guard ensures we keep state flat.
    const state = useLiveVoiceStore.getState();
    const stateFields: ReadonlyArray<keyof LiveVoiceStoreState> = [
      "state",
      "sessionId",
      "conversationId",
      "partialTranscript",
      "finalTranscript",
      "assistantTranscript",
      "inputAmplitude",
      "errorMessage",
    ];

    for (const field of stateFields) {
      const value = state[field];
      const isPrimitive =
        value === null ||
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean";
      expect(isPrimitive).toBe(true);
    }
  });
});
