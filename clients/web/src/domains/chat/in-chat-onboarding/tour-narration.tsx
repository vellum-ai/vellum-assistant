import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState, type ReactNode } from "react";

import { useAssistantAvatar } from "@/hooks/use-assistant-avatar";
import { contrastForeground } from "@/utils/avatar-tone";

import { TYPE_CHAR_MS, type TourStep } from "./tour-steps";

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

  const accent =
    (components &&
      traits &&
      components.colors.find((c) => c.id === traits.color)?.hex) ||
    null;

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
          className="w-full max-w-lg text-center"
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -10 }}
          transition={{ duration: 0.25 }}
        >
          {!isIntro ? (
            <div className="mb-3 flex items-center justify-center gap-2">
              <span
                aria-hidden
                className="size-2 shrink-0 rounded-full"
                style={{ background: accent ?? "var(--content-tertiary)" }}
              />
              <span
                className="text-body-medium-default"
                style={{ color: "var(--content-tertiary)" }}
              >
                {step.title}
              </span>
            </div>
          ) : null}
          <p className="text-3xl leading-snug" style={{ color: textColor }}>
            {typed}
            <motion.span
              aria-hidden
              className="ml-0.5 inline-block h-[1.05em] w-[2px] align-[-0.15em]"
              style={{ background: cursorColor }}
              animate={{ opacity: [1, 1, 0, 0] }}
              transition={{ duration: 0.9, repeat: Infinity }}
            />
          </p>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );

  return (
    <div className="relative h-full min-h-0 w-full flex-1">
      <div
        className="absolute right-0 left-0 flex flex-col items-center px-6"
        style={isIntro ? { top: "30vh" } : { top: "14vh" }}
      >
        {/* Reserve the text block's height so the controls below don't jump
            while the narration types or swaps between beats. */}
        <div className="flex min-h-[9rem] w-full flex-col items-center justify-start">
          {textBlock}
        </div>
        {controls ? <div className="mt-4">{controls}</div> : null}
      </div>
    </div>
  );
}
