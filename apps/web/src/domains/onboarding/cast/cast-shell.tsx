/**
 * Shared presentation helpers for the cast onboarding flow.
 *
 * These are the small, reusable pieces the orchestrator and the per-step screens
 * (PRs 5b–5g) all draw on: the blinking avatar, the typewriter primitive, the
 * rotating-word headline, the persistent setup shell, the ghost placeholder, the
 * theme toggle, and the "making of" memory list. Ported from the prototype's
 * `interactive-setup.tsx`; screen-specific components live in `screens/`.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";

import { COMPONENTS } from "@/domains/onboarding/cast/cast-roster";
import type { CastCharacter } from "@/domains/onboarding/cast/cast-roster";
import { ALL_STEPS } from "@/domains/onboarding/cast/cast-task-derivation";
import { computeTransforms, resolveDefinitions } from "@/utils/avatar-svg-compositor";
import { publicAsset } from "@/utils/public-asset";

// ---------------------------------------------------------------------------
// BlinkingAvatar — character that blinks and gazes downward
// ---------------------------------------------------------------------------

const AVATAR_SIZE = 240;

export function BlinkingAvatar({ character }: { character: CastCharacter }) {
  const { bodyShape, eyeStyle, color } = useMemo(
    () => resolveDefinitions(COMPONENTS, character.bodyShape, character.eyeStyle, character.color),
    [character.bodyShape, character.eyeStyle, character.color],
  );

  const { bodyTransform, eyeTransform } = useMemo(
    () => computeTransforms(bodyShape, eyeStyle, COMPONENTS, AVATAR_SIZE),
    [bodyShape, eyeStyle],
  );

  // Compute eye center in output coordinates for blink transform-origin.
  const eyeCenter = useMemo(() => {
    const bodyVB = bodyShape.viewBox;
    const bodyScale = Math.min(AVATAR_SIZE / bodyVB.width, AVATAR_SIZE / bodyVB.height);
    const bodyTx = (AVATAR_SIZE - bodyVB.width * bodyScale) / 2;
    const bodyTy = (AVATAR_SIZE - bodyVB.height * bodyScale) / 2;
    const override = COMPONENTS.faceCenterOverrides.find(
      (o) => o.bodyShape === bodyShape.id && o.eyeStyle === eyeStyle.id,
    );
    const faceCenter = override ? override.faceCenter : bodyShape.faceCenter;
    const eyeVB = eyeStyle.sourceViewBox;
    const remapScale = Math.min(bodyVB.width / eyeVB.width, bodyVB.height / eyeVB.height);
    const remapTx = faceCenter.x - eyeStyle.eyeCenter.x * remapScale;
    const remapTy = faceCenter.y - eyeStyle.eyeCenter.y * remapScale;
    const x = bodyScale * (remapTx + eyeStyle.eyeCenter.x * remapScale) + bodyTx;
    const y = bodyScale * (remapTy + eyeStyle.eyeCenter.y * remapScale) + bodyTy;
    return { x, y };
  }, [bodyShape, eyeStyle]);

  const escapeAttr = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  return (
    <div className="cast-avatar" aria-hidden>
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width={AVATAR_SIZE}
        height={AVATAR_SIZE}
        viewBox={`0 0 ${AVATAR_SIZE} ${AVATAR_SIZE}`}
      >
        <path d={bodyShape.svgPath} fill={color.hex} transform={bodyTransform} />
        <g
          style={{
            transformOrigin: `${eyeCenter.x}px ${eyeCenter.y}px`,
            animation: "cast-gaze-blink 4s ease-in-out infinite",
          }}
        >
          {eyeStyle.paths.map((p, i) => (
            <path key={i} d={escapeAttr(p.svgPath)} fill={p.color} transform={eyeTransform} />
          ))}
        </g>
      </svg>
    </div>
  );
}

// ---------------------------------------------------------------------------
// TypewriterLine — types a single line character-by-character
// ---------------------------------------------------------------------------

export function TypewriterLine({ text, onDone }: { text: string; onDone: () => void }) {
  const [charCount, setCharCount] = useState(0);
  const onDoneRef = useRef(onDone);
  useEffect(() => {
    onDoneRef.current = onDone;
  });

  useEffect(() => {
    if (charCount < text.length) {
      const id = window.setTimeout(() => setCharCount((c) => c + 1), 30);
      return () => clearTimeout(id);
    }
    const id = window.setTimeout(() => onDoneRef.current(), 500);
    return () => clearTimeout(id);
  }, [charCount, text]);

  return (
    <>
      {text.slice(0, charCount)}
      <span className="cast-memory-list__cursor">|</span>
    </>
  );
}

// ---------------------------------------------------------------------------
// MemoryList — persistent "grocery list" of remembered preferences.
// Renders the shared `ALL_STEPS` (single source of truth in cast-task-derivation).
// ---------------------------------------------------------------------------

export function MemoryList({
  entries,
  typingStep,
  onTyped,
  assistantName,
}: {
  entries: [string, string][];
  typingStep: string | null;
  onTyped: () => void;
  assistantName: string;
}) {
  const doneMap = new Map(entries);

  return (
    <motion.div
      className="cast-memory-list"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 10 }}
      transition={{ duration: 0.35, ease: "easeOut" }}
    >
      <span className="cast-memory-list__label">The making of {assistantName}</span>
      <ul className="cast-memory-list__entries">
        {ALL_STEPS.map(({ step, pending, credits }) => {
          const doneText = doneMap.get(step);
          const isTyping = step === typingStep;
          const isDone = !!doneText && !isTyping;

          return (
            <li
              key={step}
              className={`cast-memory-list__entry${isDone ? " is-done" : ""}${!doneText && !isTyping ? " is-pending" : ""}`}
            >
              {isTyping ? (
                <TypewriterLine text={doneText!} onDone={onTyped} />
              ) : isDone ? (
                doneText
              ) : (
                pending
              )}
              {credits && !isDone && (
                <span className="cast-memory-list__credits">+{credits} credits</span>
              )}
            </li>
          );
        })}
      </ul>
    </motion.div>
  );
}

// ---------------------------------------------------------------------------
// RotatingWord — cycles through words with a slide-up animation
// ---------------------------------------------------------------------------

export function RotatingWord({ words }: { words: string[] }) {
  const [index, setIndex] = useState(0);
  // Find the longest word to use as an invisible sizer
  const longest = useMemo(() => words.reduce((a, b) => (a.length >= b.length ? a : b)), [words]);

  useEffect(() => {
    const id = setInterval(() => setIndex((i) => (i + 1) % words.length), 2400);
    return () => clearInterval(id);
  }, [words.length]);

  return (
    <span className="cast-login__rotating">
      {/* Invisible sizer — keeps container width of the longest word */}
      <span className="cast-login__rotating-sizer" aria-hidden>
        {longest}.
      </span>
      <AnimatePresence mode="wait">
        <motion.em
          key={words[index]}
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -16 }}
          transition={{ duration: 0.3, ease: "easeInOut" }}
        >
          {words[index]}.
        </motion.em>
      </AnimatePresence>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Preamble backdrop grid — outline characters anchored to each bottom corner.
// ---------------------------------------------------------------------------

const GRID_COLS = 3;
const GRID_ROWS = 5;
const GRID_CELL = 110;

// Grid layout: [row][col] = bodyShape or null. Row 0 = bottom.
const LEFT_GRID: (string | null)[][] = [
  ["sprout", "star", "cloud"],
  ["blob", "ghost", null],
  ["ninja", null, "burst"],
  [null, "flower", null],
  ["urchin", null, null],
];

const RIGHT_GRID: (string | null)[][] = [
  ["stack", "burst", "blob"],
  [null, "cloud", "flower"],
  ["star", "ninja", null],
  [null, "ghost", "sprout"],
  [null, null, "urchin"],
];

const OUTLINE_COLOR = "rgba(70, 193, 120, 0.06)";
const GRID_LINE_COLOR = "rgba(70, 193, 120, 0.03)";

function PreambleGrid({ grid, side }: { grid: (string | null)[][]; side: "left" | "right" }) {
  const width = GRID_COLS * GRID_CELL;
  const height = GRID_ROWS * GRID_CELL;

  const cells = useMemo(() => {
    const out: { bodyShape: string; svgPath: string; viewBox: string; col: number; row: number }[] = [];
    for (let row = 0; row < GRID_ROWS; row++) {
      for (let col = 0; col < GRID_COLS; col++) {
        const id = grid[row]?.[col];
        if (!id) continue;
        const shape = COMPONENTS.bodyShapes.find((b) => b.id === id);
        if (!shape) continue;
        out.push({
          bodyShape: id,
          svgPath: shape.svgPath,
          viewBox: `0 0 ${shape.viewBox.width} ${shape.viewBox.height}`,
          col,
          row,
        });
      }
    }
    return out;
  }, [grid]);

  return (
    <div className={`cast-preamble__grid cast-preamble__grid--${side}`} style={{ width, height }}>
      {/* Grid lines layer (masked with gradient) */}
      <div className={`cast-preamble__lines cast-preamble__lines--${side}`}>
        <svg
          className="cast-preamble__gridlines"
          viewBox={`0 0 ${width} ${height}`}
          width={width}
          height={height}
        >
          {Array.from({ length: GRID_COLS + 1 }, (_, i) => {
            if (side === "left" && i === GRID_COLS) return null;
            if (side === "right" && i === 0) return null;
            return (
              <line
                key={`v${i}`}
                x1={i * GRID_CELL}
                y1={0}
                x2={i * GRID_CELL}
                y2={height}
                stroke={GRID_LINE_COLOR}
                strokeWidth={1}
              />
            );
          })}
          {Array.from({ length: GRID_ROWS + 1 }, (_, i) => {
            if (i === 0) return null;
            return (
              <line
                key={`h${i}`}
                x1={0}
                y1={i * GRID_CELL}
                x2={width}
                y2={i * GRID_CELL}
                stroke={GRID_LINE_COLOR}
                strokeWidth={1}
              />
            );
          })}
        </svg>
      </div>
      {/* Character outlines (no mask) */}
      {cells.map((cell, i) => (
        <div
          key={i}
          className="cast-preamble__cell"
          style={{
            width: GRID_CELL,
            height: GRID_CELL,
            left: cell.col * GRID_CELL,
            top: (GRID_ROWS - 1 - cell.row) * GRID_CELL,
          }}
        >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox={cell.viewBox} width="100%" height="100%">
            <path d={cell.svgPath} fill="none" stroke={OUTLINE_COLOR} strokeWidth={12} />
          </svg>
        </div>
      ))}
    </div>
  );
}

function PreambleBoxes() {
  return (
    <div className="cast-preamble__boxes" aria-hidden>
      <PreambleGrid grid={LEFT_GRID} side="left" />
      <PreambleGrid grid={RIGHT_GRID} side="right" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// SetupShell — persistent visual shell for preamble → starter → dialogue.
// Renders the dark green gradient background, topbar, and grid boxes once.
// Center content swaps via AnimatePresence.
// ---------------------------------------------------------------------------

export function SetupShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="cast-setup-shell">
      <div className="cast-preamble__topbar">
        <img src={publicAsset("/vellum-logo-white.svg")} alt="Vellum" width={100} height={36} />
        <span className="cast-preamble__setup-label">Setting up your assistant</span>
      </div>
      <PreambleBoxes />
      <div className="cast-setup-shell__content">
        <AnimatePresence mode="wait">{children}</AnimatePresence>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// GhostAvatar — green rounded square with "?" — preamble speaker placeholder.
// ---------------------------------------------------------------------------

export function GhostAvatar() {
  return (
    <span className="cast-vn__ghost">
      <span className="cast-vn__ghost-q">?</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// CastThemeToggle — light/dark switch for the cast stage.
// ---------------------------------------------------------------------------

export function CastThemeToggle({
  theme,
  onToggle,
}: {
  theme: "dark" | "light";
  onToggle: () => void;
}) {
  return (
    <button
      className="cast-theme-toggle"
      onClick={onToggle}
      aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
    >
      {theme === "dark" ? (
        <svg
          width={18}
          height={18}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="12" cy="12" r="5" />
          <line x1="12" y1="1" x2="12" y2="3" />
          <line x1="12" y1="21" x2="12" y2="23" />
          <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
          <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
          <line x1="1" y1="12" x2="3" y2="12" />
          <line x1="21" y1="12" x2="23" y2="12" />
          <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
          <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
        </svg>
      ) : (
        <svg
          width={18}
          height={18}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
        </svg>
      )}
    </button>
  );
}
