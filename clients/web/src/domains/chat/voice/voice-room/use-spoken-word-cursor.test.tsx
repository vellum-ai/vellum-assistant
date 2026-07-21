/**
 * Tests for `useSpokenWordCursor`.
 *
 * Frames are driven manually through the shared rAF harness
 * (`raf.test-helper.ts`), pumped inside `act()`. Playback progress is driven
 * through the real live-voice store by registering a provider that reads a
 * mutable local value; the store is reset between tests.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { act, cleanup, renderHook } from "@testing-library/react";

import { useLiveVoiceStore } from "@/domains/chat/voice/live-voice/live-voice-store";
import type { LiveVoicePlaybackProgress } from "@/domains/chat/voice/live-voice/tts-playback";
import {
  installRafTestHarness,
  type RafTestHarness,
} from "@/domains/chat/voice/raf.test-helper";
import { useSpokenWordCursor } from "@/domains/chat/voice/voice-room/use-spoken-word-cursor";

let raf: RafTestHarness;
let progress: LiveVoicePlaybackProgress | null;

/** Fire every pending rAF callback once, inside `act()`. */
function pumpFrame() {
  act(() => {
    raf.fireFrame();
  });
}

beforeEach(() => {
  raf = installRafTestHarness();
  progress = null;
  useLiveVoiceStore.getState().reset();
  useLiveVoiceStore.getState().setPlaybackProgressProvider(() => progress);
});

afterEach(() => {
  cleanup();
  raf.restore();
  useLiveVoiceStore.getState().reset();
});

describe("useSpokenWordCursor — mapping", () => {
  test("null progress yields a null cursor (caller keeps its default highlight)", () => {
    const { result } = renderHook(() => useSpokenWordCursor(10));
    pumpFrame();
    expect(result.current).toBeNull();
  });

  test("fraction 0.5 over 10 words maps to index 5", () => {
    progress = { playedSeconds: 5, totalSeconds: 10 };
    const { result } = renderHook(() => useSpokenWordCursor(10));
    pumpFrame();
    expect(result.current).toBe(5);
  });

  test("zero-duration progress is not usable audio and keeps the cursor null", () => {
    progress = { playedSeconds: 0, totalSeconds: 0 };
    const { result } = renderHook(() => useSpokenWordCursor(10));
    pumpFrame();
    expect(result.current).toBeNull();
  });
});

describe("useSpokenWordCursor — drained-queue hold", () => {
  test("a caught-up queue (played == total) does not advance the cursor past its floor", () => {
    progress = { playedSeconds: 5, totalSeconds: 10 };
    const { result } = renderHook(() => useSpokenWordCursor(20));
    pumpFrame();
    expect(result.current).toBe(10);

    // Mid-response silence: the queue drains while the LLM text streams ahead.
    progress = { playedSeconds: 10, totalSeconds: 10 };
    pumpFrame();
    pumpFrame();
    expect(result.current).toBe(10);
  });

  test("text deltas growing wordCount while drained do not move the cursor", () => {
    progress = { playedSeconds: 5, totalSeconds: 10 };
    const { result, rerender } = renderHook(
      ({ count }: { count: number }) => useSpokenWordCursor(count),
      { initialProps: { count: 10 } },
    );
    pumpFrame();
    expect(result.current).toBe(5);

    progress = { playedSeconds: 10, totalSeconds: 10 };
    rerender({ count: 20 });
    pumpFrame();
    expect(result.current).toBe(5);

    rerender({ count: 30 });
    pumpFrame();
    expect(result.current).toBe(5);
  });

  test("the cursor reaches the last word during final-buffer playback and holds after the drain", () => {
    progress = { playedSeconds: 9.9, totalSeconds: 10 };
    const { result } = renderHook(() => useSpokenWordCursor(10));
    pumpFrame();
    expect(result.current).toBe(9);

    progress = { playedSeconds: 10, totalSeconds: 10 };
    pumpFrame();
    expect(result.current).toBe(9);
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

describe("useSpokenWordCursor — audio-less responses", () => {
  test("the cursor takes over once the response's first progress arrives", () => {
    const { result } = renderHook(() => useSpokenWordCursor(10));
    pumpFrame();
    expect(result.current).toBeNull();

    progress = { playedSeconds: 4, totalSeconds: 10 };
    pumpFrame();
    expect(result.current).toBe(4);
  });
});

describe("useSpokenWordCursor — per-response reset", () => {
  test("shrinking wordCount resets the cursor to null until the new response's audio starts", () => {
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
    pumpFrame();
    expect(result.current).toBeNull();

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
    expect(raf.pendingCallbacks()).toHaveLength(0);
  });

  test("unmount cancels the pending frame", () => {
    const { unmount } = renderHook(() => useSpokenWordCursor(10));
    expect(raf.pendingCallbacks()).toHaveLength(1);
    unmount();
    expect(raf.pendingCallbacks()).toHaveLength(0);
  });
});
