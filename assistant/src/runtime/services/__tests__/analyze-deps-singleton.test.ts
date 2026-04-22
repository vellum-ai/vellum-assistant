/**
 * Unit tests for the analyze-deps singleton.
 *
 * The singleton holds the ConversationAnalysisDeps bundle so background
 * callers (e.g. job handlers) can invoke analyzeConversation() without
 * HTTP-layer wiring. Tests exercise the get/set round-trip, the null
 * default before startup, and last-write-wins semantics.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import type { ConversationAnalysisDeps } from "../analyze-conversation.js";
import { getAnalysisDeps, setAnalysisDeps } from "../analyze-deps-singleton.js";

// Helper: build a minimal ConversationAnalysisDeps object. The content is
// irrelevant to the singleton — it only stores and returns the reference.
function makeDeps(tag: string): ConversationAnalysisDeps {
  return {
    // The cast is safe: the singleton never dereferences these fields.
    sendMessageDeps: {
      _tag: tag,
    } as unknown as ConversationAnalysisDeps["sendMessageDeps"],
    buildConversationDetailResponse: () => ({ tag }),
  };
}

// The singleton is module-level state. Reset it between tests by writing a
// fresh value (or by clearing via a sentinel pattern — but we keep it simple
// and rely on explicit overwrites since setAnalysisDeps is last-write-wins).
// The "before startup" behavior is validated by the first describe block,
// which must run before any set call — bun:test executes tests in source
// order within a file, and this describe runs first.
describe("analyze-deps singleton (pre-startup)", () => {
  test("getAnalysisDeps() returns null before setAnalysisDeps() is called", () => {
    // This test relies on source order: it runs before any setAnalysisDeps()
    // call in this file. If this test moves, it may start to observe deps
    // set by earlier tests.
    expect(getAnalysisDeps()).toBeNull();
  });
});

describe("analyze-deps singleton (round-trip)", () => {
  beforeEach(() => {
    // Reset to a known "unset" by writing a sentinel, then overwriting in each
    // test. We cannot truly null the singleton without exposing a reset
    // helper; tests instead assert on identity/equality.
  });

  test("getAnalysisDeps() returns the same object after setAnalysisDeps() is called", () => {
    const deps = makeDeps("round-trip");
    setAnalysisDeps(deps);
    expect(getAnalysisDeps()).toBe(deps);
  });

  test("multiple setAnalysisDeps() calls update the singleton (last write wins)", () => {
    const first = makeDeps("first");
    const second = makeDeps("second");

    setAnalysisDeps(first);
    expect(getAnalysisDeps()).toBe(first);

    setAnalysisDeps(second);
    expect(getAnalysisDeps()).toBe(second);
    expect(getAnalysisDeps()).not.toBe(first);
  });
});
