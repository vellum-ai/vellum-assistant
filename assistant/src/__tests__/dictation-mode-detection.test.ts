import { describe, expect, test } from "bun:test";

import { detectDictationModeHeuristic as detectDictationMode } from "../daemon/handlers/dictation.js";
import type { DictationRequest } from "../daemon/message-protocol.js";

type DictationRequestOverrides = Omit<Partial<DictationRequest>, "context"> & {
  context?: Partial<DictationRequest["context"]>;
};

function makeRequest(
  overrides: DictationRequestOverrides = {},
): DictationRequest {
  const base: DictationRequest = {
    type: "dictation_request",
    transcription: "hello there",
    context: {
      bundleIdentifier: "com.google.Chrome",
      appName: "Google Chrome",
      windowTitle: "Inbox - Gmail",
      selectedText: undefined,
      cursorInTextField: false,
    },
  };
  return {
    ...base,
    ...overrides,
    context: {
      ...base.context,
      ...(overrides.context ?? {}),
    },
  };
}

describe("detectDictationMode", () => {
  test("uses command mode when selected text exists", () => {
    const mode = detectDictationMode(
      makeRequest({
        transcription: "make this friendlier",
        context: {
          selectedText: "Please send me the files.",
          cursorInTextField: true,
        },
      }),
    );
    expect(mode).toBe("command");
  });

  test("uses action mode for action-verb utterances", () => {
    const mode = detectDictationMode(
      makeRequest({
        transcription: "send Alex a follow up",
        context: { selectedText: undefined, cursorInTextField: false },
      }),
    );
    expect(mode).toBe("action");
  });

  test("uses dictation mode when cursor is in a text field", () => {
    const mode = detectDictationMode(
      makeRequest({
        transcription: "quick update on status",
        context: { cursorInTextField: true },
      }),
    );
    expect(mode).toBe("dictation");
  });

  test("defaults to dictation when context is ambiguous", () => {
    const mode = detectDictationMode(
      makeRequest({
        transcription: "just checking in about tomorrow",
        context: { selectedText: undefined, cursorInTextField: false },
      }),
    );
    expect(mode).toBe("dictation");
  });

  test("profileId does not affect mode detection", () => {
    const dictation = detectDictationMode(
      makeRequest({
        profileId: "work",
        transcription: "hello there",
        context: { cursorInTextField: true },
      }),
    );
    expect(dictation).toBe("dictation");

    const command = detectDictationMode(
      makeRequest({
        profileId: "casual",
        transcription: "make this shorter",
        context: {
          selectedText: "some long text here",
          cursorInTextField: true,
        },
      }),
    );
    expect(command).toBe("command");

    const action = detectDictationMode(
      makeRequest({
        profileId: "work",
        transcription: "send Alex a follow up",
        context: { selectedText: undefined, cursorInTextField: false },
      }),
    );
    expect(action).toBe("action");
  });

  // --- Edge cases (extended coverage) ---

  test("empty transcription → dictation (no verb match)", () => {
    const mode = detectDictationMode(
      makeRequest({
        transcription: "",
        context: { selectedText: undefined, cursorInTextField: false },
      }),
    );
    expect(mode).toBe("dictation");
  });

  test("uppercase action verb is lowercased before matching", () => {
    const mode = detectDictationMode(
      makeRequest({
        transcription: "Send a message to Bob",
        context: { selectedText: undefined, cursorInTextField: false },
      }),
    );
    expect(mode).toBe("action");
  });

  test("whitespace-only selected text does NOT trigger command mode", () => {
    const mode = detectDictationMode(
      makeRequest({
        transcription: "hello world",
        context: { selectedText: "   ", cursorInTextField: true },
      }),
    );
    // "   ".trim().length === 0, so selectedText check should fail
    // Falls through to dictation (cursor in text field)
    expect(mode).toBe("dictation");
  });

  test("action verb as second word → dictation (only first word checked)", () => {
    const mode = detectDictationMode(
      makeRequest({
        transcription: "please send this email",
        context: { selectedText: undefined, cursorInTextField: false },
      }),
    );
    // "please" is the first word, not an action verb
    expect(mode).toBe("dictation");
  });

  test("cursor in text field, no selected text, non-action verb → dictation", () => {
    const mode = detectDictationMode(
      makeRequest({
        transcription: "the meeting is at three pm",
        context: { selectedText: undefined, cursorInTextField: true },
      }),
    );
    expect(mode).toBe("dictation");
  });

  test("action verbs: slack, email, search, schedule all return action", () => {
    for (const verb of ["slack", "email", "search", "schedule"]) {
      const mode = detectDictationMode(
        makeRequest({
          transcription: `${verb} something`,
          context: { selectedText: undefined, cursorInTextField: false },
        }),
      );
      expect(mode).toBe("action");
    }
  });

  test("selected text overrides action verb → command", () => {
    const mode = detectDictationMode(
      makeRequest({
        transcription: "send this to marketing",
        context: {
          selectedText: "Q4 revenue report draft",
          cursorInTextField: true,
        },
      }),
    );
    // "send" is an action verb, but selectedText takes priority
    expect(mode).toBe("command");
  });
});
