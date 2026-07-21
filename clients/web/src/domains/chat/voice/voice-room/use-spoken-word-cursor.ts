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
 * Until the loop observes audio still scheduled the hook returns `null`,
 * letting the caller keep its default highlight. Adoption (the `null` →
 * numeric transition) requires a frame with `playedSeconds < totalSeconds`: a
 * first read that is already drained keeps the `null` cursor, so a response
 * whose audio finished before the loop ever saw it (a short ack under a
 * throttled or busy main thread) — like one that produces no TTS audio at all
 * — is not pinned to an early word.
 *
 * Advancement is rate-capped to a plausible speaking cadence. Each frame
 * accrues a fractional word budget from the played-audio delta
 * ({@link MAX_CURSOR_WORDS_PER_SECOND}), and the cursor moves at most the
 * accrued whole words past its current position, consuming the budget it uses.
 * While displayed text leads synthesis the mapped fraction can sweep far ahead
 * of real speech (approaching an underrun it lands near the end of the
 * displayed transcript); the cap keeps the highlight near the truly spoken
 * word instead of letting the monotonic floor pin the overshoot. The adoption
 * frame is exempt — a mid-response mount (a caption toggle) jumps straight to
 * the playhead — and the budget resets on adoption and with the per-response
 * reset.
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
 * Ceiling on cursor advancement, in words per second of played audio.
 * Comfortably above real speech (~2–3 words/sec) so the cap never binds while
 * the mapping tracks actual playback; it only clamps the sweep when the
 * fraction maps a short spoken prefix onto a much longer displayed transcript.
 */
const MAX_CURSOR_WORDS_PER_SECOND = 5;

/**
 * Index (into the caller's word segmentation) of the word the TTS playhead is
 * speaking, or `null` while the current response has produced no audio (the
 * caller keeps its default highlight). `wordCount` of 0 idles the loop
 * entirely (the caller passes 0 for an empty or hidden caption).
 */
export function useSpokenWordCursor(wordCount: number): number | null {
  const [index, setIndex] = useState<number | null>(null);
  // Single source of truth for the cursor between renders: always equals the
  // last returned value, serving as both the monotonic floor and the guard
  // that skips the state write when a frame leaves the index unchanged.
  const cursorRef = useRef<number | null>(null);
  // Rate-cap state: playedSeconds at the previous frame, and the fractional
  // word budget accrued from played-audio deltas since the last consumption.
  const prevPlayedRef = useRef<number | null>(null);
  const budgetRef = useRef(0);
  const prevCountRef = useRef(wordCount);

  // Declared before the loop effect so a shrink (transcript cleared for a new
  // response) clears the cursor before the restarted loop reads it. Synced in
  // an effect, not during render (no render-phase ref writes).
  useEffect(() => {
    if (wordCount < prevCountRef.current) {
      cursorRef.current = null;
      prevPlayedRef.current = null;
      budgetRef.current = 0;
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
        // A caught-up queue (played == total) yields no candidate: the drained
        // fraction of 1.0 says nothing about displayed words with no
        // synthesized audio yet, so a null cursor stays null (default
        // highlight) and a numeric one holds its floor.
        const mapped = Math.floor(
          (progress.playedSeconds / progress.totalSeconds) * wordCount,
        );
        const candidate =
          progress.playedSeconds < progress.totalSeconds &&
          Number.isFinite(mapped)
            ? Math.min(mapped, wordCount - 1)
            : null;
        if (cursorRef.current === null) {
          if (candidate !== null) {
            // Adoption: jump straight to the playhead, uncapped, so a
            // mid-response mount (a caption toggle) syncs instantly. The rate
            // cap applies from here on.
            next = candidate;
            prevPlayedRef.current = progress.playedSeconds;
            budgetRef.current = 0;
          }
        } else {
          // Accrue advancement budget from real played audio. A non-positive
          // delta (a fresh player restarting the clock) accrues nothing. The
          // bank is clamped to about one second of advancement: real speech
          // consumes less than the accrual rate, and an unclamped surplus
          // banked over a long response would let a later text burst spend it
          // all in one frame — a sweep onto unspoken words that the cap
          // exists to prevent. The clamp keeps just enough headroom for the
          // cursor to catch up after rAF jank.
          if (prevPlayedRef.current !== null) {
            const playedDelta = progress.playedSeconds - prevPlayedRef.current;
            if (playedDelta > 0) {
              budgetRef.current = Math.min(
                budgetRef.current + playedDelta * MAX_CURSOR_WORDS_PER_SECOND,
                MAX_CURSOR_WORDS_PER_SECOND,
              );
            }
          }
          prevPlayedRef.current = progress.playedSeconds;
          const floor = cursorRef.current;
          if (candidate !== null && candidate > floor) {
            const advance = Math.min(
              candidate - floor,
              Math.floor(budgetRef.current),
            );
            next = floor + advance;
            budgetRef.current -= advance;
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
