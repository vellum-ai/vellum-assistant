import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { useAssistantAvatar } from "@/hooks/use-assistant-avatar";
import { REST_SCALE, eyeStyleBaseWidth } from "@/utils/assistant-eyes";
import { contrastForeground } from "@/utils/avatar-tone";
import { pathBBox, unionBBox } from "@/utils/eye-bbox";

import { IntroEyesLine } from "./intro-eyes-line";
import { type TourEyeArt } from "./tour-nav-flood";
import { TYPE_CHAR_MS, type TourStep } from "./tour-steps";

/** The intro's under-text eyes over a nav row's resting size — small,
 *  sized to tuck beneath the headline's words. */
const INTRO_EYES_GROWTH = 3;

interface TourNarrationProps {
  assistantId: string | null;
  /** The stop currently being showcased; null between stops (text fades). */
  step: TourStep | null;
  /**
   * `intro`: the full-page takeover — the text sits above the giant eyes in
   * the avatar-colored flood, contrast-toned, with no title chip.
   * `top`: the walk's default — title chip + text at the takeover's top.
   */
  variant: "intro" | "top";
  /** Navigation cluster rendered centered directly below the text. */
  controls?: ReactNode;
}


/**
 * The tour's takeover of the main chat area: while the tour sits on a beat,
 * that beat's description typewrites here. Deliberately ephemeral — the
 * text fades the moment the tour moves on, no dismissal chrome.
 */
export function TourNarration({
  assistantId,
  step,
  variant,
  controls,
}: TourNarrationProps) {
  const { components, traits } = useAssistantAvatar(assistantId);
  const [typed, setTyped] = useState("");

  const typedDone = step != null && typed.length >= step.body.length;

  const accent =
    (components &&
      traits &&
      components.colors.find((c) => c.id === traits.color)?.hex) ||
    null;

  const eyeArt = useMemo<TourEyeArt | null>(() => {
    if (!components || !traits) {
      return null;
    }
    const def = components.eyeStyles.find((e) => e.id === traits.eyeStyle);
    if (!def) {
      return null;
    }
    return {
      id: def.id,
      paths: def.paths,
      bbox: unionBBox(def.paths.map((p) => pathBBox(p.svgPath))),
    };
  }, [components, traits]);

  useEffect(() => {
    setTyped("");
    if (!step) {
      return;
    }
    let count = 0;
    const id = window.setInterval(() => {
      count += 1;
      setTyped(step.body.slice(0, count));
      if (count >= step.body.length) {
        clearInterval(id);
      }
    }, TYPE_CHAR_MS);
    return () => clearInterval(id);
  }, [step]);

  const isIntro = variant === "intro";
  /** On the flooded intro the text reads in the avatar color's contrast
   *  tone; elsewhere it uses the app's standard content tones. */
  const textColor =
    isIntro && accent ? contrastForeground(accent) : "var(--content-strong)";
  const cursorColor =
    isIntro && accent
      ? contrastForeground(accent)
      : (accent ?? "var(--content-tertiary)");

  const textBlock = (
    <AnimatePresence mode="wait">
      {step ? (
        <motion.div
          key={step.id}
          className={isIntro ? "w-full text-center" : "w-full text-left"}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -10 }}
          transition={{ duration: 0.25 }}
        >
          {!isIntro ? (
            <div className="mb-3 flex items-center gap-2.5">
              {step.icon ? (
                <step.icon
                  aria-hidden
                  className="h-6 w-6 shrink-0"
                  style={{ color: accent ?? "var(--content-tertiary)" }}
                />
              ) : (
                <span
                  aria-hidden
                  className="size-2 shrink-0 rounded-full"
                  style={{ background: accent ?? "var(--content-tertiary)" }}
                />
              )}
              <span
                className="text-body-medium-default"
                style={{ color: "var(--content-tertiary)" }}
              >
                {step.title}
              </span>
            </div>
          ) : null}
          <p
            className={
              // The intro line must stay on ONE line — the eyes-under-text
              // choreography measures letter x-positions along a single
              // baseline and the sprite slides along it.
              isIntro
                ? "text-8xl leading-tight whitespace-nowrap"
                : "text-4xl leading-snug"
            }
            style={{
              color: textColor,
              // The tour is the assistant speaking in its own voice — the
              // display serif, matching the identity page's typewritten
              // greeting.
              fontFamily: "var(--font-serif)",
            }}
          >
            {isIntro && typedDone && eyeArt ? (
              // Typing done: the same text re-renders as measurable words
              // and the avatar's small eyes slide beneath them, bumping
              // each word up in passing before parking under "show".
              <IntroEyesLine
                words={step.body.split(" ")}
                eye={eyeArt}
                eyesWidth={
                  eyeStyleBaseWidth(eyeArt.id) * REST_SCALE * INTRO_EYES_GROWTH
                }
              />
            ) : (
              <>
                {typed}
                <motion.span
                  aria-hidden
                  className="ml-0.5 inline-block h-[1.05em] w-[2px] align-[-0.15em]"
                  style={{ background: cursorColor }}
                  animate={{ opacity: [1, 1, 0, 0] }}
                  transition={{ duration: 0.9, repeat: Infinity }}
                />
              </>
            )}
          </p>
          {/* The intro's CTA cluster lives in the text's own flow — one
              composed moment — and only rises in once the line has finished
              typing, completing the narrative beat. Roomy top margin: the
              headline's eyes hang below the baseline into this gap. */}
          {isIntro && controls ? (
            <motion.div
              className="mt-20 flex justify-center"
              initial={{ opacity: 0, y: 8 }}
              animate={typedDone ? { opacity: 1, y: 0 } : { opacity: 0, y: 8 }}
              transition={{ duration: 0.35, ease: "easeOut" }}
              style={{ pointerEvents: typedDone ? "auto" : "none" }}
            >
              {controls}
            </motion.div>
          ) : null}
        </motion.div>
      ) : null}
    </AnimatePresence>
  );

  return (
    <div className="relative h-full min-h-0 w-full flex-1">
      {isIntro ? (
        // The intro's CTA rides inside the text block itself — no height
        // reservation, nothing floating loose in the flood.
        <div
          className="absolute right-0 left-0 flex flex-col items-center px-6"
          style={{ top: "28vh" }}
        >
          {textBlock}
        </div>
      ) : (
        // The walk narrates from the transcript's spot: the chat content
        // column, left-aligned like an assistant message. No top padding —
        // the overlay pins this column to the side menu's top edge so the
        // step title aligns with the top of the menu panel.
        <div className="mx-auto flex w-full max-w-[var(--chat-max-width)] flex-col items-start px-4 sm:px-6">
          {/* Reserve the text block's height so the controls below don't
              jump while the narration types or swaps between beats. */}
          <div className="flex min-h-[9rem] w-full flex-col items-start justify-start">
            {textBlock}
          </div>
          {controls ? <div className="mt-4 self-center">{controls}</div> : null}
        </div>
      )}
    </div>
  );
}
