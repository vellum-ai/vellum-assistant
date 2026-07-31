/**
 * The overview page's greeting headline — "Hi, I'm {name}" — typed out
 * character-by-character on mount. The pencil opens the avatar modal
 * character-by-character on mount. Editing lives on the avatar itself
 * (clicking it opens the avatar/name modal); a spinner appears beside the
 * name while a rename rewrite turn is in flight.
 *
 * The headline reserves the full greeting's width with an invisible copy
 * while the typewriter runs, so surrounding layout never shifts
 * mid-animation. Reduced motion renders the greeting instantly.
 */

import { useEffect, useState } from "react";
import { useReducedMotion } from "motion/react";

const TYPEWRITER_INTERVAL_MS = 65;
/** Override lines are longer and transient — type them snappier. */
const OVERRIDE_TYPEWRITER_INTERVAL_MS = 26;

function useTypewriter(
  text: string,
  intervalMs: number,
): { typed: string; typing: boolean } {
  const reduce = useReducedMotion();
  const [count, setCount] = useState(reduce ? text.length : 0);

  useEffect(() => {
    if (reduce) {
      setCount(text.length);
      return;
    }
    setCount(0);
    const id = setInterval(() => {
      setCount((c) => {
        if (c >= text.length) {
          clearInterval(id);
          return c;
        }
        return c + 1;
      });
    }, intervalMs);
    return () => clearInterval(id);
  }, [text, intervalMs, reduce]);

  return { typed: text.slice(0, count), typing: count < text.length };
}

interface AssistantNameEditorProps {
  name: string;
  /** A rename rewrite turn is in flight — show a spinner beside the name. */
  isRenaming: boolean;
  /**
   * Replaces the greeting with a transient in-character line (card hover
   * commentary, the personality-rewrite notice).
   */
  overrideText?: string | null;
}

export function AssistantNameEditor({
  name,
  isRenaming,
  overrideText = null,
}: AssistantNameEditorProps) {
  const greeting = overrideText ?? `Hi, I’m ${name}`;
  const { typed, typing } = useTypewriter(
    greeting,
    overrideText ? OVERRIDE_TYPEWRITER_INTERVAL_MS : TYPEWRITER_INTERVAL_MS,
  );

  return (
    <div className="flex items-center justify-center gap-2">
      <h1
        aria-label={greeting}
        className={`relative leading-none whitespace-nowrap text-[var(--content-strong)] ${
          overrideText
            ? "text-[2.1rem] max-sm:text-[1.4rem]"
            : "text-[3.25rem] max-sm:text-[2rem]"
        }`}
        style={{ fontFamily: "var(--font-serif)" }}
      >
        {/* Invisible full greeting reserves the final width. */}
        <span className="invisible" aria-hidden="true">
          {greeting}
        </span>
        <span className="absolute inset-0" aria-hidden="true">
          {typed}
          {typing && <span className="animate-pulse">▎</span>}
        </span>
      </h1>
      {!overrideText && isRenaming && (
        <div
          aria-label="Renaming in progress"
          className="h-5 w-5 shrink-0 animate-spin rounded-full border-2 border-[var(--border-base)]"
          style={{ borderTopColor: "var(--content-default)" }}
        />
      )}
    </div>
  );
}
