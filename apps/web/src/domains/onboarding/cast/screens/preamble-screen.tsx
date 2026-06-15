/**
 * `preamble` screen — the story intro keyed off the user's first name.
 *
 * Renders the typewriter greeting + body lines that introduce the assistant,
 * then advances on click. The dark-green grid backdrop, topbar, and gradient
 * are supplied by `SetupShell` (from `cast-shell`), which the orchestrator wraps
 * around this phase — so this screen renders only the centered dialogue content.
 *
 * Styling: layout/typography use Tailwind + design tokens (`--content-*`,
 * `--app-spacing-*`, `--font-serif`). The blink choreography reuses the shared
 * `cast-blink` keyframe from `cast-animations.css`.
 */

import { useEffect, useMemo, useState } from "react";
import { motion } from "motion/react";

import type { PreambleScreenProps } from "@/domains/onboarding/cast/screens/screen-slot";

function preambleGreeting(firstName: string) {
  return `Nice to meet you, ${firstName}`;
}

function preambleLines() {
  return [
    "I’m your new AI assistant. I can live in your browser, on your computer, in Gmail, Slack, or anywhere else you work.",
    "I’ll learn how you like things done and get better every day.",
    "First, let’s figure out who I am.",
  ];
}

// Serif title matching the cast about/heading treatment (Instrument Serif via
// the `--font-serif` token, fluid clamp size). Left-aligned in the preamble.
const HEADING_CLASS =
  "m-0 mb-[var(--app-spacing-xl)] text-left font-serif text-[clamp(2.1rem,1rem+2.8vw,3.75rem)] font-normal leading-[1.15] tracking-[-0.01em] text-[var(--content-default)]";
const BODY_CLASS =
  "m-0 text-[20px] font-light leading-[1.6] text-[var(--content-default)]";
const CURSOR_CLASS =
  "inline animate-[cast-blink_0.6s_steps(2)_infinite] font-light text-[var(--content-tertiary)]";
const ADVANCE_CLASS =
  "mt-[var(--app-spacing-lg)] inline-block animate-[cast-blink_1.2s_ease-in-out_infinite] text-[14px] font-[620] text-[var(--content-secondary)]";
// Reserve the final dimensions so the typewriter never reflows the layout.
const STACK_CLASS = "flex max-w-[500px] flex-col gap-[var(--app-spacing-xl)] text-left";

export function PreambleScreen({ firstName, onAdvance }: PreambleScreenProps) {
  const greeting = useMemo(() => preambleGreeting(firstName), [firstName]);
  const lines = useMemo(() => preambleLines(), []);
  const totalLen = useMemo(() => lines.reduce((n, l) => n + l.length, 0), [lines]);
  const [charCount, setCharCount] = useState(0);
  const typed = charCount >= totalLen;

  // Typewriter for the greeting heading.
  const [greetCharCount, setGreetCharCount] = useState(0);
  const greetTyped = greetCharCount >= greeting.length;

  useEffect(() => {
    if (greetTyped) return;
    const id = window.setTimeout(() => setGreetCharCount((c) => c + 1), 65);
    return () => clearTimeout(id);
  }, [greetCharCount, greetTyped]);

  // Don't start the body typewriter until the greeting is done.
  const bodyStarted = greetTyped;

  useEffect(() => {
    if (!bodyStarted || typed) return;
    const id = window.setTimeout(() => setCharCount((c) => c + 1), 50);
    return () => clearTimeout(id);
  }, [charCount, typed, bodyStarted]);

  function handleClick() {
    if (!greetTyped) {
      setGreetCharCount(greeting.length);
      return;
    }
    if (!typed) {
      setCharCount(totalLen);
      return;
    }
    onAdvance();
  }

  let remaining = charCount;
  const revealed: string[] = [];
  const reached: boolean[] = [];
  for (const line of lines) {
    reached.push(remaining > 0);
    revealed.push(remaining > 0 ? line.slice(0, remaining) : "");
    remaining -= line.length;
  }
  const typingLineIdx = typed
    ? -1
    : revealed.findIndex((r, i) => r.length < lines[i].length && reached[i]);

  return (
    <motion.div
      key="preamble"
      className="relative flex h-full w-full cursor-pointer flex-col items-center justify-center p-[var(--app-spacing-xxl)]"
      onClick={handleClick}
      initial={{ opacity: 0, y: 40 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -40 }}
      transition={{ duration: 0.5, ease: "easeOut" }}
    >
      <div className="relative">
        {/* Invisible full content to reserve the final dimensions. */}
        <div aria-hidden className={`${STACK_CLASS} invisible`}>
          <h2 className={HEADING_CLASS}>{greeting}</h2>
          {lines.map((line, i) => (
            <p key={i} className={BODY_CLASS}>
              {line}
            </p>
          ))}
          <span className={ADVANCE_CLASS}>Next &#9660;</span>
        </div>
        {/* Visible typed overlay. */}
        <div className={`${STACK_CLASS} absolute inset-0`}>
          <h2 className={HEADING_CLASS}>
            {greeting.slice(0, greetCharCount)}
            {!greetTyped && <span className={CURSOR_CLASS}>|</span>}
          </h2>
          {bodyStarted &&
            lines.map((line, i) => {
              if (!reached[i]) return null;
              return (
                <p key={i} className={BODY_CLASS}>
                  {revealed[i]}
                  {i === typingLineIdx && <span className={CURSOR_CLASS}>|</span>}
                </p>
              );
            })}
          {typed && <span className={ADVANCE_CLASS}>Next &#9660;</span>}
        </div>
      </div>
    </motion.div>
  );
}
