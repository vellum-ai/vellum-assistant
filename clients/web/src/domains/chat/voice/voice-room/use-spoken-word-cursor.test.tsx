/**
 * Tests for `useSpokenWordCursor`.
 *
 * `requestAnimationFrame` is monkey-patched to capture callbacks so frames are
 * pumped manually inside `act()` (same harness as
 * `voice-timeline-waveform.test.tsx`). Playback progress is driven through the
 * real live-voice store by registering a provider that reads a mutable local
 * value; the store is reset between tests.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { act, cleanup, renderHook } from "@testing-library/react";

import { useLiveVoiceStore } from "@/domains/chat/voice/live-voice/live-voice-store";
import type { LiveVoicePlaybackProgress } from "@/domains/chat/voice/live-voice/tts-playback";
import { useSpokenWordCursor } from "@/domains/chat/voice/voice-room/use-spoken-word-cursor";

// ---------------------------------------------------------------------------
// requestAnimationFrame harness
// ---------------------------------------------------------------------------

let rafCallbacks: Map<number, FrameRequestCallback>;
let nextRafId = 1;
let originalRaf: typeof globalThis.requestAnimationFrame;
let originalCancelRaf: typeof globalThis.cancelAnimationFrame;

/** Fire every pending rAF callback once, inside `act()`. */
function pumpFrame() {
  act(() => {
    const callbacks = [...rafCallbacks.values()];
    rafCallbacks.clear();
    for (const cb of callbacks) {
      cb(performance.now());
    }
  });
}

// ---------------------------------------------------------------------------
// Playback-progress fake
// ---------------------------------------------------------------------------

let progress: LiveVoicePlaybackProgress | null;

beforeEach(() => {
  rafCallbacks = new Map();
  nextRafId = 1;
  originalRaf = globalThis.requestAnimationFrame;
  originalCancelRaf = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    const id = nextRafId++;
    rafCallbacks.set(id, cb);
    return id;
  }) as typeof globalThis.requestAnimationFrame;
  globalThis.cancelAnimationFrame = ((id: number) => {
    rafCallbacks.delete(id);
  }) as typeof globalThis.cancelAnimationFrame;

  progress = null;
  useLiveVoiceStore.getState().reset();
  useLiveVoiceStore.getState().setPlaybackProgressProvider(() => progress);
});

afterEach(() => {
  cleanup();
  globalThis.requestAnimationFrame = originalRaf;
  globalThis.cancelAnimationFrame = originalCancelRaf;
  useLiveVoiceStore.getState().reset();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("useSpokenWordCursor — mapping", () => {
  test("null progress maps to the first word", () => {
    const { result } = renderHook(() => useSpokenWordCursor(10));
    pumpFrame();
    expect(result.current).toBe(0);
  });

  test("fraction 0.5 over 10 words maps to index 5", () => {
    progress = { playedSeconds: 5, totalSeconds: 10 };
    const { result } = renderHook(() => useSpokenWordCursor(10));
    pumpFrame();
    expect(result.current).toBe(5);
  });

  test("fraction 1.0 clamps to the last word", () => {
    progress = { playedSeconds: 10, totalSeconds: 10 };
    const { result } = renderHook(() => useSpokenWordCursor(10));
    pumpFrame();
    expect(result.current).toBe(9);
  });

  test("zero-duration progress holds the floor instead of dividing by zero", () => {
    progress = { playedSeconds: 0, totalSeconds: 0 };
    const { result } = renderHook(() => useSpokenWordCursor(10));
    pumpFrame();
    expect(result.current).toBe(0);
  });
});

describe("useSpokenWordCursor — monotonicity", () => {
  test("a smaller fraction does not move the cursor backward", () => {
    progress = { playedSeconds: 5, totalSeconds: 10 };
    const { result } = renderHook(() => useSpokenWordCursor(10));
    pumpFrame();
    expect(result.current).toBe(5);

    // Total grows faster than played (a new audio burst), dipping the ratio.
    progress = { playedSeconds: 6, totalSeconds: 20 };
    pumpFrame();
    expect(result.current).toBe(5);
  });

  test("progress flipping to null (barge-in flush) freezes the cursor", () => {
    progress = { playedSeconds: 5, totalSeconds: 10 };
    const { result } = renderHook(() => useSpokenWordCursor(10));
    pumpFrame();
    expect(result.current).toBe(5);

    progress = null;
    pumpFrame();
    pumpFrame();
    expect(result.current).toBe(5);
  });
});

describe("useSpokenWordCursor — per-response reset", () => {
  test("shrinking wordCount resets the floor and the cursor restarts at 0", () => {
    progress = { playedSeconds: 8, totalSeconds: 10 };
    const { result, rerender } = renderHook(
      ({ count }: { count: number }) => useSpokenWordCursor(count),
      { initialProps: { count: 10 } },
    );
    pumpFrame();
    expect(result.current).toBe(8);

    // New response: the transcript clears (shorter word list), progress resets.
    progress = null;
    rerender({ count: 3 });
    expect(result.current).toBe(0);

    progress = { playedSeconds: 1, totalSeconds: 3 };
    pumpFrame();
    expect(result.current).toBe(1);
  });

  test("growing wordCount (streaming append) keeps the floor", () => {
    progress = { playedSeconds: 5, totalSeconds: 10 };
    const { result, rerender } = renderHook(
      ({ count }: { count: number }) => useSpokenWordCursor(count),
      { initialProps: { count: 10 } },
    );
    pumpFrame();
    expect(result.current).toBe(5);

    progress = null;
    rerender({ count: 12 });
    pumpFrame();
    expect(result.current).toBe(5);
  });
});

describe("useSpokenWordCursor — render economy and lifecycle", () => {
  test("frames with an unchanged index do not re-render", () => {
    let renders = 0;
    progress = { playedSeconds: 5, totalSeconds: 10 };
    const { result } = renderHook(() => {
      renders += 1;
      return useSpokenWordCursor(10);
    });
    pumpFrame();
    expect(result.current).toBe(5);
    const rendersAfterFirstIndex = renders;

    pumpFrame();
    pumpFrame();
    pumpFrame();
    expect(renders).toBe(rendersAfterFirstIndex);

    progress = { playedSeconds: 6, totalSeconds: 10 };
    pumpFrame();
    expect(result.current).toBe(6);
    expect(renders).toBe(rendersAfterFirstIndex + 1);
  });

  test("wordCount 0 schedules no frames", () => {
    renderHook(() => useSpokenWordCursor(0));
    expect(rafCallbacks.size).toBe(0);
  });

  test("unmount cancels the pending frame", () => {
    const { unmount } = renderHook(() => useSpokenWordCursor(10));
    expect(rafCallbacks.size).toBe(1);
    unmount();
    expect(rafCallbacks.size).toBe(0);
  });
});
