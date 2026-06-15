/**
 * `preamble` screen — the story intro keyed off the user's first name.
 *
 * Renders the typewriter greeting + body lines that introduce the assistant,
 * then advances on click. The dark-green grid backdrop, topbar, and gradient
 * are supplied by `SetupShell` (from `cast-shell`), which the orchestrator wraps
 * around this phase — so this screen renders only the centered dialogue content.
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
      className="cast-vn cast-vn--centered cast-vn--clickable cast-vn--embedded"
      onClick={handleClick}
      initial={{ opacity: 0, y: 40 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -40 }}
      transition={{ duration: 0.5, ease: "easeOut" }}
    >
      <div className="cast-vn__bottom" style={{ position: "relative" }}>
        {/* Invisible full content to reserve the final dimensions. */}
        <div aria-hidden className="cast-vn__bottom" style={{ visibility: "hidden" }}>
          <h2 className="cast-about__heading" style={{ textAlign: "left" }}>
            {greeting}
          </h2>
          {lines.map((line, i) => (
            <p key={i} className="cast-vn__text">
              {line}
            </p>
          ))}
          <span className="cast-vn__advance">Next &#9660;</span>
        </div>
        {/* Visible typed overlay. */}
        <div className="cast-vn__bottom" style={{ position: "absolute", inset: 0 }}>
          <h2 className="cast-about__heading" style={{ textAlign: "left" }}>
            {greeting.slice(0, greetCharCount)}
            {!greetTyped && <span className="cast-vn__cursor">|</span>}
          </h2>
          {bodyStarted &&
            lines.map((line, i) => {
              if (!reached[i]) return null;
              return (
                <p key={i} className="cast-vn__text">
                  {revealed[i]}
                  {i === typingLineIdx && <span className="cast-vn__cursor">|</span>}
                </p>
              );
            })}
          {typed && <span className="cast-vn__advance">Next &#9660;</span>}
        </div>
      </div>
    </motion.div>
  );
}
