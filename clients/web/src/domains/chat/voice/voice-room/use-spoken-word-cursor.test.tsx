/**
 * Tests for `useSpokenWordCursor`.
 *
 * Frames are driven manually through the shared rAF harness
 * (`raf.test-helper.ts`) via its act-aware `pumpFrame`. Playback progress is
 * driven through the real live-voice store by registering a provider that
 * reads a mutable local value; the store is reset between tests.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { cleanup, renderHook } from "@testing-library/react";

import { useLiveVoiceStore } from "@/domains/chat/voice/live-voice/live-voice-store";
import type { LiveVoicePlaybackProgress } from "@/domains/chat/voice/live-voice/tts-playback";
import {
  installRafTestHarness,
  type RafTestHarness,
} from "@/domains/chat/voice/raf.test-helper";
import { useSpokenWordCursor } from "@/domains/chat/voice/voice-room/use-spoken-word-cursor";

let raf: RafTestHarness;
let progress: LiveVoicePlaybackProgress | null;

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
    raf.pumpFrame();
    expect(result.current).toBeNull();
  });

  test("fraction 0.5 over 10 words maps to index 5", () => {
    progress = { playedSeconds: 5, totalSeconds: 10 };
    const { result } = renderHook(() => useSpokenWordCursor(10));
    raf.pumpFrame();
    expect(result.current).toBe(5);
  });

  test("zero-duration progress is not usable audio and keeps the cursor null", () => {
    progress = { playedSeconds: 0, totalSeconds: 0 };
    const { result } = renderHook(() => useSpokenWordCursor(10));
    raf.pumpFrame();
    expect(result.current).toBeNull();
  });
});

describe("useSpokenWordCursor — drained-queue hold", () => {
  test("a caught-up queue (played == total) does not advance the cursor past its floor", () => {
    progress = { playedSeconds: 5, totalSeconds: 10 };
    const { result } = renderHook(() => useSpokenWordCursor(20));
    raf.pumpFrame();
    expect(result.current).toBe(10);

    // Mid-response silence: the queue drains while the LLM text streams ahead.
    progress = { playedSeconds: 10, totalSeconds: 10 };
    raf.pumpFrame();
    raf.pumpFrame();
    expect(result.current).toBe(10);
  });

  test("text deltas growing wordCount while drained do not move the cursor", () => {
    progress = { playedSeconds: 5, totalSeconds: 10 };
    const { result, rerender } = renderHook(
      ({ count }: { count: number }) => useSpokenWordCursor(count),
      { initialProps: { count: 10 } },
    );
    raf.pumpFrame();
    expect(result.current).toBe(5);

    progress = { playedSeconds: 10, totalSeconds: 10 };
    rerender({ count: 20 });
    raf.pumpFrame();
    expect(result.current).toBe(5);

    rerender({ count: 30 });
    raf.pumpFrame();
    expect(result.current).toBe(5);
  });

  test("a first read that is already drained keeps the cursor null", () => {
    // The audio finished before the loop ever observed a sub-total frame
    // (short response under a throttled or busy main thread): the caller
    // keeps its default highlight instead of a pinned early word.
    progress = { playedSeconds: 10, totalSeconds: 10 };
    const { result } = renderHook(() => useSpokenWordCursor(10));
    raf.pumpFrame();
    raf.pumpFrame();
    expect(result.current).toBeNull();
  });

  test("adoption happens on the first frame with audio still scheduled", () => {
    progress = { playedSeconds: 10, totalSeconds: 10 };
    const { result } = renderHook(() => useSpokenWordCursor(10));
    raf.pumpFrame();
    expect(result.current).toBeNull();

    // A new audio burst grows the total: audio is scheduled again.
    progress = { playedSeconds: 10, totalSeconds: 12 };
    raf.pumpFrame();
    expect(result.current).toBe(8);
  });

  test("the cursor reaches the last word during final-buffer playback and holds after the drain", () => {
    progress = { playedSeconds: 9.9, totalSeconds: 10 };
    const { result } = renderHook(() => useSpokenWordCursor(10));
    raf.pumpFrame();
    expect(result.current).toBe(9);

    progress = { playedSeconds: 10, totalSeconds: 10 };
    raf.pumpFrame();
    expect(result.current).toBe(9);
  });
});

describe("useSpokenWordCursor — monotonicity", () => {
  test("a smaller fraction does not move the cursor backward", () => {
    progress = { playedSeconds: 5, totalSeconds: 10 };
    const { result } = renderHook(() => useSpokenWordCursor(10));
    raf.pumpFrame();
    expect(result.current).toBe(5);

    // Total grows faster than played (a new audio burst), dipping the ratio.
    progress = { playedSeconds: 6, totalSeconds: 20 };
    raf.pumpFrame();
    expect(result.current).toBe(5);
  });

  test("progress flipping to null (barge-in flush) freezes the cursor", () => {
    progress = { playedSeconds: 5, totalSeconds: 10 };
    const { result } = renderHook(() => useSpokenWordCursor(10));
    raf.pumpFrame();
    expect(result.current).toBe(5);

    progress = null;
    raf.pumpFrame();
    raf.pumpFrame();
    expect(result.current).toBe(5);
  });
});

describe("useSpokenWordCursor — rate cap", () => {
  test("a mapped candidate sweeping far ahead advances only by the played-audio budget", () => {
    progress = { playedSeconds: 10, totalSeconds: 100 };
    const { result } = renderHook(() => useSpokenWordCursor(100));
    raf.pumpFrame();
    // Adoption: floor(0.1 * 100) = 10 (spoken ceiling floor(10 × 3.3) = 33
    // does not bind).
    expect(result.current).toBe(10);

    // Near-underrun: played approaches total, so the fraction sweeps toward 1
    // (candidate bounded by the spoken ceiling floor(10.5 × 3.3) = 34) while
    // only 0.5s of audio actually played. Budget = 0.5 * 5 words/sec = 2
    // whole words.
    progress = { playedSeconds: 10.5, totalSeconds: 10.6 };
    raf.pumpFrame();
    expect(result.current).toBe(12);
  });

  test("while text streams ahead of audio, the cursor advances at speech pace", () => {
    // Mid-stream: 100 words are displayed but only 4s of audio is scheduled
    // (the synthesized prefix). The raw fraction maps 2s played onto word 50;
    // the spoken ceiling floor(2 × 3.3) = 6 keeps the highlight where real
    // speech can actually be.
    progress = { playedSeconds: 2, totalSeconds: 4 };
    const { result } = renderHook(() => useSpokenWordCursor(100));
    raf.pumpFrame();
    expect(result.current).toBe(6);
  });

  test("a normal speaking cadence is never rate-limited", () => {
    // ~1 word per 0.4s of played audio (2.5 words/sec), under the cap.
    progress = { playedSeconds: 0.4, totalSeconds: 4 };
    const { result } = renderHook(() => useSpokenWordCursor(10));
    raf.pumpFrame();
    expect(result.current).toBe(1);

    for (let step = 2; step <= 9; step += 1) {
      progress = { playedSeconds: 0.4 * step, totalSeconds: 4 };
      raf.pumpFrame();
      expect(result.current).toBe(step);
    }
  });

  test("budget banked during long tracking cannot fund a one-frame sweep", () => {
    // Track a 100-word response at a normal ~2.5 words/sec cadence: accrual
    // (5 words/sec) outpaces consumption, so an unclamped bank would grow by
    // ~1 word per step and later fund a full sweep in a single frame.
    progress = { playedSeconds: 0.4, totalSeconds: 40 };
    const { result } = renderHook(() => useSpokenWordCursor(100));
    raf.pumpFrame();
    expect(result.current).toBe(1);

    for (let step = 2; step <= 40; step += 1) {
      progress = { playedSeconds: 0.4 * step, totalSeconds: 40 };
      raf.pumpFrame();
      expect(result.current).toBe(step);
    }

    // Underrun sweep: the fraction jumps near 1 (candidate 97) while only
    // 0.5s more audio played. Spendable this frame = the stored bank
    // (clamped to 5 words) + the 0.5s of newly played audio (2.5 words), so
    // the cursor moves at most 7 words past its floor instead of sweeping to
    // the candidate.
    progress = { playedSeconds: 16.5, totalSeconds: 17 };
    raf.pumpFrame();
    expect(result.current).toBe(47);
  });

  test("a delayed frame spends its full earned allowance at once", () => {
    // Adoption: floor(0.2 * 100) = 20 (spoken ceiling floor(8 × 3.3) = 26
    // does not bind); bank zeroed.
    progress = { playedSeconds: 8, totalSeconds: 40 };
    const { result } = renderHook(() => useSpokenWordCursor(100));
    raf.pumpFrame();
    expect(result.current).toBe(20);

    // A 2s gap between frames (throttled tab while audio plays on) earns
    // 2 × 5 = 10 words, all spendable in the frame that observes it — even
    // against a near-1 fraction (candidate bounded to the spoken ceiling 33)
    // the cursor advances by the full earned allowance instead of crawling at
    // the stored-bank ceiling.
    progress = { playedSeconds: 10, totalSeconds: 10.4 };
    raf.pumpFrame();
    expect(result.current).toBe(30);
  });

  test("the adoption jump is uncapped", () => {
    const { result } = renderHook(() => useSpokenWordCursor(30));
    raf.pumpFrame();
    expect(result.current).toBeNull();

    // Mid-response mount: the first usable frame syncs straight to the
    // playhead, floor(0.8 * 30) = 24, with no budget accrued yet (spoken
    // ceiling floor(8 × 3.3) = 26 does not bind).
    progress = { playedSeconds: 8, totalSeconds: 10 };
    raf.pumpFrame();
    expect(result.current).toBe(24);
  });
});

describe("useSpokenWordCursor — audio-less responses", () => {
  test("the cursor takes over once the response's first progress arrives", () => {
    const { result } = renderHook(() => useSpokenWordCursor(10));
    raf.pumpFrame();
    expect(result.current).toBeNull();

    progress = { playedSeconds: 4, totalSeconds: 10 };
    raf.pumpFrame();
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
    raf.pumpFrame();
    expect(result.current).toBe(8);

    // New response: the transcript clears (shorter word list), progress resets.
    progress = null;
    rerender({ count: 3 });
    raf.pumpFrame();
    expect(result.current).toBeNull();

    progress = { playedSeconds: 1, totalSeconds: 3 };
    raf.pumpFrame();
    expect(result.current).toBe(1);
  });

  test("growing wordCount (streaming append) keeps the floor", () => {
    progress = { playedSeconds: 5, totalSeconds: 10 };
    const { result, rerender } = renderHook(
      ({ count }: { count: number }) => useSpokenWordCursor(count),
      { initialProps: { count: 10 } },
    );
    raf.pumpFrame();
    expect(result.current).toBe(5);

    progress = null;
    rerender({ count: 12 });
    raf.pumpFrame();
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
    raf.pumpFrame();
    expect(result.current).toBe(5);
    const rendersAfterFirstIndex = renders;

    raf.pumpFrame();
    raf.pumpFrame();
    raf.pumpFrame();
    expect(renders).toBe(rendersAfterFirstIndex);

    progress = { playedSeconds: 6, totalSeconds: 10 };
    raf.pumpFrame();
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
