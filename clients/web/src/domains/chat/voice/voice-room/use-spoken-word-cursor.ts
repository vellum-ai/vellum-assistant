/**
 * Word cursor driven by the TTS audio playhead, for the voice-room transcript's
 * leading-edge highlight.
 *
 * A `requestAnimationFrame` loop polls {@link getLiveVoicePlaybackProgress}
 * (played/total seconds of the current response's scheduled audio) and maps the
 * played fraction onto the caller's word count:
 * `floor((playedSeconds / totalSeconds) * wordCount)`, clamped to the last
 * word. The mapping assumes words take roughly equal speaking time — close
 * enough for a caption highlight.
 *
 * Accepted bias: scheduled audio corresponds to *synthesized* text, which can
 * lag the displayed LLM text mid-stream, so the fraction maps a shorter spoken
 * prefix onto the longer displayed transcript and can overshoot the truly
 * spoken word slightly. The error is bounded by the synthesis lag and
 * self-corrects as synthesis catches up — and it still tracks speech far more
 * closely than the text-arrival edge it replaces.
 *
 * The cursor is monotonic within a response: a smaller fraction (e.g. the
 * played/total ratio dipping when a new audio burst grows the total) never
 * moves it backward, and a `null` progress read (barge-in flush clearing the
 * player) freezes it where speech stopped. The floor resets when `wordCount`
 * shrinks below its previous value — the transcript cleared for a new
 * response — so each response starts at the first word.
 *
 * State updates land only when the mapped index changes, so the poll runs at
 * frame rate but the subscriber re-renders at word granularity. Reduced
 * motion: the cursor advances regardless — the visual it drives is a
 * color-only change owned by `VoiceTranscriptText`, which already gates its
 * motion separately.
 */

import { useEffect, useRef, useState } from "react";

import { getLiveVoicePlaybackProgress } from "@/domains/chat/voice/live-voice/live-voice-store";

/**
 * Index (into the caller's word segmentation) of the word the TTS playhead is
 * speaking. Returns 0 while no audio progress exists. `wordCount` of 0 idles
 * the loop entirely (the assistant caption unmounts on an empty transcript).
 */
export function useSpokenWordCursor(wordCount: number): number {
  const [index, setIndex] = useState(0);
  // Monotonic floor for the current response; always equals the last returned
  // index, so the loop skips the state write when the index is unchanged.
  const floorRef = useRef(0);
  const prevCountRef = useRef(wordCount);

  // Declared before the loop effect so a shrink (transcript cleared for a new
  // response) zeroes the floor before the restarted loop reads it. Synced in
  // an effect, not during render (no render-phase ref writes).
  useEffect(() => {
    if (wordCount < prevCountRef.current) {
      floorRef.current = 0;
      setIndex(0);
    }
    prevCountRef.current = wordCount;
  }, [wordCount]);

  useEffect(() => {
    if (wordCount <= 0) {
      return;
    }
    let raf = 0;
    const tick = () => {
      const progress = getLiveVoicePlaybackProgress();
      // `null` progress → hold the floor: 0 for a fresh response, or frozen
      // where speech stopped after a barge-in flush.
      let candidate = floorRef.current;
      if (progress !== null && progress.totalSeconds > 0) {
        const mapped = Math.floor(
          (progress.playedSeconds / progress.totalSeconds) * wordCount,
        );
        if (Number.isFinite(mapped)) {
          candidate = Math.min(mapped, wordCount - 1);
        }
      }
      const next = Math.max(candidate, floorRef.current);
      if (next !== floorRef.current) {
        floorRef.current = next;
        setIndex(next);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [wordCount]);

  return index;
}
