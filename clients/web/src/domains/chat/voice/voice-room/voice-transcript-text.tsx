/**
 * Word-by-word reveal for the voice room's live captions.
 *
 * The live transcript streams in a word (or few) at a time; rendering it as one
 * flat string makes each update land as a hard text swap. This splits the text
 * into words keyed by position so that, as the string grows, only the newly
 * arrived words mount — each fading + rising + de-blurring into place — while
 * the words already on screen stay put. The most recent word carries a brighter
 * "leading edge" tone that cools to the muted base as the next word arrives, so
 * the caption reads as speech flowing forward rather than a block appearing.
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

export function VoiceTranscriptText({ text }: { text: string }) {
  const reduce = useReducedMotion();
  // Collapse runs of whitespace to single spaces — the words are laid out with
  // real space text nodes between them (so they wrap and select naturally, and
  // `textContent` reads back as the plain sentence).
  const words = useMemo(() => text.split(/\s+/).filter(Boolean), [text]);
  const lastIndex = words.length - 1;

  return (
    <>
      {words.map((word, i) => {
        const leading = i === lastIndex;
        return (
          <Fragment key={i}>
            <motion.span
              className="inline-block"
              style={{
                color: leading
                  ? "var(--room-fg, var(--content-secondary))"
                  : "var(--room-fg-muted, var(--content-tertiary))",
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
