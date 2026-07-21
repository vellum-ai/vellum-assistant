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
 * The cursor advances only while audio remains scheduled
 * (`playedSeconds < totalSeconds`). When the queue is caught up
 * (played == total — a mid-response silence while synthesis lags the streamed
 * text, or the post-response drain) the drained fraction of 1.0 says nothing
 * about displayed words that have no synthesized audio yet, so the cursor
 * holds at the last spoken word; the next audio burst grows the total and the
 * cursor advances again. End-of-response landing: the fraction sweeps toward 1
 * during the final buffer's playback, carrying the cursor onto the last word
 * before the drain.
 *
 * Until the current response schedules audio the hook returns `null`, letting
 * the caller keep its default highlight — a response that produces no TTS
 * audio at all (text streaming through a TTS failure) is not pinned to the
 * first word.
 *
 * Accepted bias: scheduled audio corresponds to *synthesized* text, which can
 * lag the displayed LLM text mid-stream, so the fraction maps a shorter spoken
 * prefix onto the longer displayed transcript and can overshoot the truly
 * spoken word slightly. The error is bounded by the synthesis lag and
 * self-corrects as synthesis catches up.
 *
 * The cursor is monotonic within a response: a smaller fraction (e.g. the
 * played/total ratio dipping when a new audio burst grows the total) never
 * moves it backward, and a `null` progress read (barge-in flush clearing the
 * player) freezes it where speech stopped. The cursor resets to `null` when
 * `wordCount` shrinks below its previous value — the transcript cleared for a
 * new response — so each response starts on the caller's default highlight
 * until its own audio arrives.
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
 * speaking, or `null` while the current response has produced no audio (the
 * caller keeps its default highlight). `wordCount` of 0 idles the loop
 * entirely (the assistant caption unmounts on an empty transcript).
 */
export function useSpokenWordCursor(wordCount: number): number | null {
  const [index, setIndex] = useState<number | null>(null);
  // Single source of truth for the cursor between renders: always equals the
  // last returned value, serving as both the monotonic floor and the guard
  // that skips the state write when a frame leaves the index unchanged.
  const cursorRef = useRef<number | null>(null);
  const prevCountRef = useRef(wordCount);

  // Declared before the loop effect so a shrink (transcript cleared for a new
  // response) clears the cursor before the restarted loop reads it. Synced in
  // an effect, not during render (no render-phase ref writes).
  useEffect(() => {
    if (wordCount < prevCountRef.current) {
      cursorRef.current = null;
      setIndex(null);
    }
    prevCountRef.current = wordCount;
  }, [wordCount]);

  useEffect(() => {
    if (wordCount <= 0) {
      return;
    }
    let raf = 0;
    const tick = () => {
      // `null` progress → hold: `null` for a fresh response, or frozen where
      // speech stopped after a barge-in flush.
      let next = cursorRef.current;
      const progress = getLiveVoicePlaybackProgress();
      if (progress !== null && progress.totalSeconds > 0) {
        // Audio exists for this response, so the cursor is numeric from here:
        // at least the floor (0 for a fresh response), advancing only while
        // audio remains scheduled — a caught-up queue (played == total) holds
        // rather than mapping the drained fraction onto unspoken words.
        const floor = cursorRef.current ?? 0;
        next = floor;
        if (progress.playedSeconds < progress.totalSeconds) {
          const mapped = Math.floor(
            (progress.playedSeconds / progress.totalSeconds) * wordCount,
          );
          if (Number.isFinite(mapped)) {
            next = Math.max(Math.min(mapped, wordCount - 1), floor);
          }
        }
      }
      if (next !== cursorRef.current) {
        cursorRef.current = next;
        setIndex(next);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [wordCount]);

  return index;
}
