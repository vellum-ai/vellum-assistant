/**
 * Word-by-word reveal for the voice room's live captions.
 *
 * The live transcript streams in a word (or few) at a time; rendering it as one
 * flat string makes each update land as a hard text swap. This splits the text
 * into words keyed by position so that, as the string grows, only the newly
 * arrived words mount — each fading + rising + de-blurring into place — while
 * the words already on screen stay put. By default the most recent word carries
 * a brighter "leading edge" tone that cools to the muted base as the next word
 * arrives, so the caption reads as speech flowing forward rather than a block
 * appearing. When the caller supplies an audio-playhead cursor via
 * `highlightIndex`, the leading edge tracks the *spoken* word instead of the
 * last-arrived one, so the highlight stays with the voice even while the
 * streamed text runs ahead of TTS.
 *
 * Index keys (not content) are deliberate: a streaming append leaves earlier
 * indices unchanged so they never re-animate, and a partial-transcript revision
 * (STT rewriting the tail) just updates those words in place. Colors follow the
 * room tone (`--room-fg` / `--room-fg-muted`) with the theme content tokens as
 * the fallback, so captions match the room chrome over any avatar color.
 *
 * Accessibility: the words stay in the accessibility tree (NOT `aria-hidden`) —
 * the caller wraps this in the `aria-live` region, and the plain sentence is
 * exactly its `textContent`, so screen readers announce the transcript as it
 * streams. The per-word animation is purely visual (transform/opacity/color)
 * and doesn't change what's read. Reduced motion drops the per-word entrance
 * (words appear immediately) but keeps the leading-edge tone.
 */

import { Fragment, useMemo } from "react";
import { motion, useReducedMotion } from "motion/react";

/**
 * The exact word segmentation the component renders (whitespace runs collapse,
 * empty tokens drop). Exported so the spoken-word cursor maps audio progress
 * onto the same words the render uses.
 */
export function splitTranscriptWords(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

export function VoiceTranscriptText({
  text,
  color,
  highlightIndex,
}: {
  text: string;
  /**
   * Paints every word this single tone (a flat reveal). Omit to keep the
   * two-tone look — the leading-edge word brighter (`--room-fg`), the settled
   * words muted (`--room-fg-muted`). Takes precedence over `highlightIndex`.
   */
  color?: string;
  /**
   * Index (into `splitTranscriptWords(text)`) of the word carrying the bright
   * leading-edge tone — supplied by an audio-playhead cursor so the highlight
   * tracks the currently *spoken* word. Clamped to the rendered words; the
   * caller owns monotonicity. Omit to keep the default last-word leading edge.
   */
  highlightIndex?: number;
}) {
  const reduce = useReducedMotion();
  // A caller-supplied `color` flattens the reveal to one tone; otherwise the
  // leading edge reads brighter than the settled words.
  const leadingColor = color ?? "var(--room-fg, var(--content-secondary))";
  const baseColor = color ?? "var(--room-fg-muted, var(--content-tertiary))";
  // Collapse runs of whitespace to single spaces — the words are laid out with
  // real space text nodes between them (so they wrap and select naturally, and
  // `textContent` reads back as the plain sentence).
  const words = useMemo(() => splitTranscriptWords(text), [text]);
  const lastIndex = words.length - 1;
  // Non-finite cursors (e.g. a NaN from not-yet-initialized playhead math)
  // normalize to the first word — clamping alone would propagate NaN and leave
  // no word carrying the leading tone.
  const leadingIndex =
    highlightIndex === undefined
      ? lastIndex
      : Number.isFinite(highlightIndex)
        ? Math.min(Math.max(0, Math.floor(highlightIndex)), lastIndex)
        : 0;

  return (
    <>
      {words.map((word, i) => {
        const leading = i === leadingIndex;
        return (
          <Fragment key={i}>
            <motion.span
              // `max-w-full` + break-anywhere so a single long token (URL, code)
              // wraps within its container instead of overflowing the narrow
              // transcript rail and being clipped.
              className="inline-block max-w-full [overflow-wrap:anywhere]"
              // Marks the word carrying the bright leading-edge tone. The tone
              // itself is the `color` below; the attribute is the observable
              // for tests (happy-dom drops `var()` colors with fallbacks from
              // inline style) and for debugging the spoken-word cursor.
              data-leading={leading || undefined}
              style={{
                color: leading ? leadingColor : baseColor,
                // The leading-edge tone eases back to the base as the next word
                // takes over (the motion entrance below owns transform/opacity).
                transition: "color 0.45s ease",
              }}
              initial={reduce ? false : { opacity: 0, y: 5, filter: "blur(2px)" }}
              animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
              transition={{ duration: reduce ? 0 : 0.32, ease: "easeOut" }}
            >
              {word}
            </motion.span>
            {i < lastIndex ? " " : null}
          </Fragment>
        );
      })}
    </>
  );
}
