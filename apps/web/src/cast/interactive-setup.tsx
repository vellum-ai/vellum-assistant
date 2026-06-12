import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { AnimatePresence, motion } from "motion/react";
import { routes } from "@/utils/routes";

import {
  assembleJobMessage,
  assembleRatherMessage,
  EDGES,
  RATHERS,
  type Edge,
  type JobKey,
  type RatherKey,
} from "@/cast/cast-content";
import { CAST as _CAST, COMPONENTS } from "@/cast/cast-roster";
import { type MimeState, type Rect } from "@/cast/cast-hero";
import { composeSvg as _composeSvg, computeTransforms, resolveDefinitions } from "@/utils/avatar-svg-compositor";
import {
  kickoffJobContext,
  kickoffRatherContext,
  type StyleProfile,
} from "@/cast/cast-hooks";
import { CastConversationView, useCastConversation } from "@/cast/cast-conversation";
import { CastProof } from "@/cast/cast-proof-view";
import { CastStarter, type StarterResume } from "@/cast/cast-starter";
import { CastStyle } from "@/cast/cast-style";
import { jobTurn, ratherTurn, styleTurn } from "@/cast/cast-templates";
import { CastTwoPanel } from "@/cast/cast-two-panel";
import type { CastCharacter } from "@/cast/cast-roster";
import { useAssistantSelectionStore } from "@/assistant/selection-store";
import { AppleLogo } from "@/components/icons/apple-logo";
import { GoogleLogo } from "@/components/icons/google-logo";
import { GitHubLogo } from "@/components/icons/github-logo";
import { SlackLogo } from "@/components/icons/slack-logo";
import { publicAsset } from "@/utils/public-asset";
import "@/cast/cast.css";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CastCompletionData {
  character: CastCharacter;
  name: string;
  jobs: JobKey[];
  rathers: RatherKey[];
  style: StyleProfile;
  credits: number;
}

type CastPhase = "login" | "preamble" | "starter" | "dialogue" | "vibe" | "brain" | "email" | "job" | "rather" | "style" | "done";

// ---------------------------------------------------------------------------
// Shared layout helpers (same as cast-page.tsx)
// ---------------------------------------------------------------------------

function topBoxFor(w: number, h: number): Rect {
  const size = Math.max(120, Math.min(176, Math.min(w, h) * 0.2));
  return { left: w / 2 - size / 2, top: h * 0.05, size };
}

const win = () => ({
  w: typeof window === "undefined" ? 1280 : window.innerWidth,
  h: typeof window === "undefined" ? 900 : window.innerHeight,
});

// ---------------------------------------------------------------------------
// BlinkingAvatar — character that blinks and gazes downward
// ---------------------------------------------------------------------------

const AVATAR_SIZE = 240;

function BlinkingAvatar({ character }: { character: CastCharacter }) {
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

function TypewriterLine({ text, onDone }: { text: string; onDone: () => void }) {
  const [charCount, setCharCount] = useState(0);
  const onDoneRef = useRef(onDone);
  useEffect(() => { onDoneRef.current = onDone; });

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
// MemoryList — persistent "grocery list" of remembered preferences
// ---------------------------------------------------------------------------

const ALL_STEPS: { step: string; pending: string; credits?: number }[] = [
  { step: "face", pending: "Look & feel" },
  { step: "tone", pending: "Communication style" },
  // { step: "brain", pending: "Context import", credits: 50 },
  { step: "reach", pending: "Primary channel", credits: 25 },
  // { step: "email", pending: "Email address" },
];

function MemoryList({
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
// ToneChoice — single This/That round: "How do I talk?"
// Rendered inside the cast panel between character selection and jobs.
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function ToneChoice({
  character,
  name: _name,
  onPick,
  onBack,
}: {
  character: CastCharacter;
  name: string;
  onPick: (value: "fast" | "deep") => void;
  onBack: () => void;
}) {
  const [picked, setPicked] = useState<"left" | "right" | null>(null);

  function choose(side: "left" | "right") {
    if (picked) return;
    setPicked(side);
    onPick(side === "left" ? "fast" : "deep");
  }

  return (
    <motion.div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        height: "100dvh",
        padding: "0 20px",
      }}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
    >
      <button className="cast-back" onClick={onBack} aria-label="Back">
        ‹
      </button>

      <div style={{ width: 140, height: 140, marginBottom: 28 }}>
        <BlinkingAvatar character={character} />
      </div>

      <div className="cast-thisthat">
        <motion.div
          className="cast-thisthat__group"
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, ease: "easeOut" }}
          style={{ gap: 0 }}
        >
          <p className="cast-thisthat__title" style={{ marginBottom: 56 }}>

            How do I talk?
          </p>
          <div className="cast-thisthat__row">
            {(["left", "right"] as const).map((side) => {
              const label = side === "left" ? "Get to the point" : "Explain everything";
              const isPicked = picked === side;
              const isUnpicked = picked !== null && !isPicked;
              return (
                <motion.button
                  key={side}
                  className="cast-vs"
                  onClick={() => choose(side)}
                  animate={
                    isPicked
                      ? { x: side === "left" ? "calc(50% + 7px)" : "calc(-50% - 7px)", scale: 1.02 }
                      : isUnpicked
                        ? { opacity: 0, scale: 0.95 }
                        : { scale: 1, opacity: 1, x: 0 }
                  }
                  transition={{ duration: 0.45, ease: "easeOut" }}
                  whileHover={picked ? undefined : { y: -6 }}
                  whileTap={picked ? undefined : { scale: 0.97 }}
                >
                  {label}
                </motion.button>
              );
            })}
          </div>
        </motion.div>
      </div>
    </motion.div>
  );
}

// ---------------------------------------------------------------------------
// VibeChoice — single This/That round: "What's my character?"
// Rendered after tone, before jobs.
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function VibeChoice({
  character,
  name: _name,
  onPick,
  onBack,
}: {
  character: CastCharacter;
  name: string;
  onPick: (value: "serious" | "friendly") => void;
  onBack: () => void;
}) {
  const [picked, setPicked] = useState<"left" | "right" | null>(null);

  function choose(side: "left" | "right") {
    if (picked) return;
    setPicked(side);
    onPick(side === "left" ? "serious" : "friendly");
  }

  return (
    <motion.div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        height: "100dvh",
        padding: "0 20px",
      }}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
    >
      <button className="cast-back" onClick={onBack} aria-label="Back">
        ‹
      </button>

      <div style={{ width: 140, height: 140, marginBottom: 28 }}>
        <BlinkingAvatar character={character} />
      </div>

      <div className="cast-thisthat">
        <motion.div
          className="cast-thisthat__group"
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, ease: "easeOut" }}
          style={{ gap: 0 }}
        >
          <p className="cast-thisthat__title" style={{ marginBottom: 56 }}>

            What's my character?
          </p>
          <div className="cast-thisthat__row">
            {(["left", "right"] as const).map((side) => {
              const label = side === "left" ? "Serious" : "Friendly";
              const isPicked = picked === side;
              const isUnpicked = picked !== null && !isPicked;
              return (
                <motion.button
                  key={side}
                  className="cast-vs"
                  onClick={() => choose(side)}
                  animate={
                    isPicked
                      ? { x: side === "left" ? "calc(50% + 7px)" : "calc(-50% - 7px)", scale: 1.02 }
                      : isUnpicked
                        ? { opacity: 0, scale: 0.95 }
                        : { scale: 1, opacity: 1, x: 0 }
                  }
                  transition={{ duration: 0.45, ease: "easeOut" }}
                  whileHover={picked ? undefined : { y: -6 }}
                  whileTap={picked ? undefined : { scale: 0.97 }}
                >
                  {label}
                </motion.button>
              );
            })}
          </div>
        </motion.div>
      </div>
    </motion.div>
  );
}

// ---------------------------------------------------------------------------
// BrainChoice — "Where do I pick up from?" — migrate context from another AI
// Rendered after vibe, before reach.
// ---------------------------------------------------------------------------

type BrainKey = "chatgpt" | "claude" | "gemini";

function ChatGPTLogo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M22.28 9.37a6.1 6.1 0 0 0-.53-5.05 6.2 6.2 0 0 0-6.68-2.98A6.1 6.1 0 0 0 10.45 0a6.2 6.2 0 0 0-5.92 4.25 6.1 6.1 0 0 0-4.1 2.96A6.2 6.2 0 0 0 1.2 13.4a6.1 6.1 0 0 0 .53 5.04 6.2 6.2 0 0 0 6.68 2.99A6.1 6.1 0 0 0 13 22.77a6.2 6.2 0 0 0 5.92-4.25 6.1 6.1 0 0 0 4.1-2.96 6.2 6.2 0 0 0-.76-6.19zM13 21.35a4.6 4.6 0 0 1-2.98-1.08l.15-.08 4.96-2.87a.81.81 0 0 0 .4-.7v-7l2.1 1.21v5.82a4.65 4.65 0 0 1-4.63 4.7zM3.6 17.42a4.6 4.6 0 0 1-.56-3.14l.15.09 4.96 2.87a.8.8 0 0 0 .81 0l6.06-3.5v2.42l-5.01 2.9a4.65 4.65 0 0 1-6.4-1.64zM2.34 7.87A4.6 4.6 0 0 1 4.78 5.8v5.91a.81.81 0 0 0 .41.7l6.06 3.5-2.1 1.21-5.02-2.9A4.65 4.65 0 0 1 2.34 7.87zm16.6 3.86L12.87 8.23l2.1-1.22 5.01 2.9a4.65 4.65 0 0 1-.72 8.38v-5.91a.81.81 0 0 0-.41-.7l.08.05zm2.09-3.15-.15-.09-4.96-2.87a.8.8 0 0 0-.81 0l-6.06 3.5V6.7l5.01-2.9a4.65 4.65 0 0 1 6.97 4.78zM8.27 13.12l-2.1-1.22V6.08a4.65 4.65 0 0 1 7.62-3.55l-.15.08-4.96 2.87a.81.81 0 0 0-.41.7v7.04zm1.14-2.46L12 9.24l2.59 1.5v2.98L12 15.22l-2.59-1.5v-2.98z" fill="currentColor"/>
    </svg>
  );
}

function ClaudeLogo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 -.01 39.5 39.53" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="m7.75 26.27 7.77-4.36.13-.38-.13-.21h-.38l-1.3-.08-4.44-.12-3.85-.16-3.73-.2-.94-.2-.88-1.16.09-.58.79-.53 1.13.1 2.5.17 3.75.26 2.72.16 4.03.42h.64l.09-.26-.22-.16-.17-.16-3.88-2.63-4.2-2.78-2.2-1.6-1.19-.81-.6-.76-.26-1.66 1.08-1.19 1.45.1.37.1 1.47 1.13 3.14 2.43 4.1 3.02.6.5.24-.17.03-.12-.27-.45-2.23-4.03-2.38-4.1-1.06-1.7-.28-1.02c-.1-.42-.17-.77-.17-1.2l1.23-1.67.68-.22 1.64.22.69.6 1.02 2.33 1.65 3.67 2.56 4.99.75 1.48.4 1.37.15.42h.26v-.24l.21-2.81.39-3.45.38-4.44.13-1.25.62-1.5 1.23-.81.96.46.79 1.13-.11.73-.47 3.05-.92 4.78-.6 3.2h.35l.4-.4 1.62-2.15 2.72-3.4 1.2-1.35 1.4-1.49.9-.71h1.7l1.25 1.86-.56 1.92-1.75 2.22-1.45 1.88-2.08 2.8-1.3 2.24.12.18.31-.03 4.7-1 2.54-.46 3.03-.52 1.37.64.15.65-.54 1.33-3.24.8-3.8.76-5.66 1.34-.07.05.08.1 2.55.24 1.09.06h2.67l4.97.37 1.3.86.78 1.05-.13.8-2 1.02-2.7-.64-6.3-1.5-2.16-.54h-.3v.18l1.8 1.76 3.3 2.98 4.13 3.84.21.95-.53.75-.56-.08-3.63-2.73-1.4-1.23-3.17-2.67h-.21v.28l.73 1.07 3.86 5.8.2 1.78-.28.58-1 .35-1.1-.2-2.26-3.17-2.33-3.57-1.88-3.2-.23.13-1.11 11.95-.52.61-1.2.46-1-.76-.53-1.23.53-2.43.64-3.17.52-2.52.47-3.13.28-1.04-.02-.07-.23.03-2.36 3.24-3.59 4.85-2.84 3.04-.68.27-1.18-.61.11-1.09.66-.97 3.93-5 2.37-3.1 1.53-1.79-.01-.26h-.09l-10.44 6.78-1.86.24-.8-.75.1-1.23.38-.4 3.14-2.16z" fill="#d97757"/>
    </svg>
  );
}

function GeminiLogo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="gemini-grad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#4285f4" />
          <stop offset="100%" stopColor="#a855f7" />
        </linearGradient>
      </defs>
      <path d="M12 0C12 6.627 6.627 12 0 12c6.627 0 12 5.373 12 12 0-6.627 5.373-12 12-12-6.627 0-12-5.373-12-12z" fill="url(#gemini-grad)" />
    </svg>
  );
}

const BRAIN_PROMPTS: Record<BrainKey, string> = {
  chatgpt:
    "Export everything you know about me: preferences, habits, recurring topics, communication style, projects, personal details, and anything else you've learned from our conversations. Create a markdown (.md) file I can download.",
  claude:
    "Export everything you know about me: preferences, habits, recurring topics, communication style, projects, personal details, and anything else you've learned from our conversations. Create a markdown (.md) file I can download.",
  gemini:
    "Export everything you know about me: preferences, habits, recurring topics, communication style, projects, personal details, and anything else you've learned from our conversations. Create a markdown (.md) file I can download.",
};

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function BrainChoice({
  character,
  name: _name,
  onPick,
  onBack,
}: {
  character: CastCharacter;
  name: string;
  onPick: (value: BrainKey, fileContent: string | null) => void;
  onBack: () => void;
}) {
  const [picked, setPicked] = useState<BrainKey | null>(null);
  const [copied, setCopied] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [droppedFile, setDroppedFile] = useState(false);
  const [showCelebration, setShowCelebration] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const fileContentRef = useRef<string | null>(null);

  const avatarColor = useMemo(() => {
    const { color } = resolveDefinitions(COMPONENTS, character.bodyShape, character.eyeStyle, character.color);
    return color.hex;
  }, [character.bodyShape, character.eyeStyle, character.color]);

  const [confettiPieces] = useState(() =>
    Array.from({ length: 40 }, () => ({
      left: `${Math.random() * 100}%`,
      delay: `${Math.random() * 0.5}s`,
      duration: `${1 + Math.random() * 1.5}s`,
      opacity: 0.4 + Math.random() * 0.6,
    })),
  );

  function choose(key: BrainKey) {
    if (picked) return;
    setPicked(key);
  }

  function handleCopy() {
    if (!picked) return;
    void navigator.clipboard.writeText(BRAIN_PROMPTS[picked]);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function handleFile(file: File) {
    const reader = new FileReader();
    reader.onload = () => {
      fileContentRef.current = reader.result as string;
      setDroppedFile(true);
      setShowCelebration(true);
      setTimeout(() => {
        if (picked) onPick(picked, fileContentRef.current);
      }, 2200);
    };
    reader.readAsText(file);
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  }

  function handleFileInput(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
  }

  function handleContinue() {
    if (!picked) return;
    onPick(picked, null);
  }

  const options: { key: BrainKey; label: string }[] = [
    { key: "chatgpt", label: "ChatGPT" },
    { key: "claude", label: "Claude" },
    { key: "gemini", label: "Gemini" },
  ];

  return (
    <motion.div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        height: "100dvh",
        padding: "0 20px",
      }}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
    >
      <button className="cast-back" onClick={onBack} aria-label="Back">
        ‹
      </button>

      <div style={{ width: 140, height: 140, marginBottom: 28 }}>
        <BlinkingAvatar character={character} />
      </div>

      <div className="cast-thisthat">
        <motion.div
          className="cast-thisthat__group"
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, ease: "easeOut" }}
          style={{ gap: 0 }}
        >
          <p className="cast-thisthat__title" style={{ marginBottom: 56 }}>

            Tell me about you
            <span className="cast-thisthat__sub">I can help you import your preferences from other tools.</span>
          </p>

          {!picked ? (
            <div className="cast-thisthat__row cast-thisthat__row--triple">
              {options.map(({ key, label }) => {
                const Logo = key === "chatgpt" ? ChatGPTLogo : key === "claude" ? ClaudeLogo : GeminiLogo;
                return (
                <motion.button
                  key={key}
                  className="cast-vs"
                  onClick={() => choose(key)}
                  transition={{ duration: 0.45, ease: "easeOut" }}
                  whileHover={{ y: -6 }}
                  whileTap={{ scale: 0.97 }}
                  style={{ flexDirection: "column", gap: 10 }}
                >
                  <Logo size={32} />
                  {label}
                </motion.button>
              );
              })}
            </div>
          ) : (
            <motion.div
              className="cast-brain-expand"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.35, ease: "easeOut" }}
            >
              <AnimatePresence mode="wait">
                {!droppedFile ? (
                  <motion.div
                    key="brain-steps"
                    exit={{ opacity: 0, y: -12 }}
                    transition={{ duration: 0.25, ease: "easeIn" }}
                  >
                    <div className="cast-brain-expand__step">
                      <span className="cast-brain-expand__num">1</span>
                      <div className="cast-brain-expand__step-body">
                        <p className="cast-brain-expand__label">
                          Copy this into {options.find((o) => o.key === picked)!.label}
                        </p>
                        <div className="cast-brain-expand__prompt">
                          <p className="cast-brain-expand__text">{BRAIN_PROMPTS[picked]}</p>
                          <button
                            type="button"
                            className="cast-brain-expand__copy"
                            onClick={handleCopy}
                          >
                            {copied ? "Copied!" : "Copy"}
                          </button>
                        </div>
                      </div>
                    </div>
                    <div className="cast-brain-expand__step">
                      <span className="cast-brain-expand__num">2</span>
                      <div className="cast-brain-expand__step-body">
                        <p className="cast-brain-expand__label">Drop the file you get back</p>
                        <div
                          className={`cast-brain-expand__drop${dragging ? " is-dragging" : ""}`}
                          onClick={() => fileInputRef.current?.click()}
                          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
                          onDragLeave={() => setDragging(false)}
                          onDrop={handleDrop}
                        >
                          <input
                            ref={fileInputRef}
                            type="file"
                            accept=".md,.markdown,.txt"
                            style={{ display: "none" }}
                            onChange={handleFileInput}
                          />
                          <span className="cast-brain-expand__drop-hint">
                            Drop or click to upload
                          </span>
                        </div>
                      </div>
                    </div>
                    <button
                      type="button"
                      className="cast-customize__continue"
                      style={{ width: "100%", marginTop: 14 }}
                      onClick={handleContinue}
                    >
                      Skip for now →
                    </button>
                  </motion.div>
                ) : (
                  <motion.div
                    key="brain-connected"
                    className="cast-brain-connected"
                    initial={{ opacity: 0, scale: 0.95 }}
                    animate={{ opacity: 1, scale: 1 }}
                    transition={{ duration: 0.35, ease: "easeOut" }}
                  >
                    <motion.span
                      className="cast-brain-connected__credits"
                      style={{
                        color: avatarColor,
                        background: `color-mix(in srgb, ${avatarColor} 16%, transparent)`,
                      }}
                      initial={{ opacity: 0, scale: 0.5 }}
                      animate={{ opacity: 1, scale: 1 }}
                      transition={{ type: "spring", stiffness: 400, damping: 18, delay: 0.3 }}
                    >
                      50/75 credits
                    </motion.span>
                    <div className="cast-brain-connected__card">
                      {(() => {
                        const Logo = picked === "chatgpt" ? ChatGPTLogo : picked === "claude" ? ClaudeLogo : GeminiLogo;
                        return <Logo size={32} />;
                      })()}
                      <span className="cast-brain-connected__label">
                        {options.find((o) => o.key === picked)!.label}
                      </span>
                      <span
                        className="cast-brain-connected__tag"
                        style={{
                          color: avatarColor,
                          background: `color-mix(in srgb, ${avatarColor} 16%, transparent)`,
                        }}
                      >
                        Connected
                      </span>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.div>
          )}

          {showCelebration && (
            <motion.div
              className="cast-celebration"
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ type: "spring", stiffness: 300, damping: 20 }}
            >
              <div className="cast-celebration__confetti">
                {confettiPieces.map((p, i) => (
                  <span key={i} className="cast-celebration__piece" style={{
                    left: p.left,
                    animationDelay: p.delay,
                    animationDuration: p.duration,
                    background: avatarColor,
                    opacity: p.opacity,
                  }} />
                ))}
              </div>
            </motion.div>
          )}
        </motion.div>
      </div>
    </motion.div>
  );
}

// ---------------------------------------------------------------------------
// ReachChoice — "Connect your tools" — two tool cards after brain import
// ---------------------------------------------------------------------------

type ReachTool = { key: string; label: string; icon: React.ReactNode; keywords: string[] };

const REACH_TOOLS: ReachTool[] = [
  {
    key: "notion",
    label: "Notion",
    icon: <img src={publicAsset("/images/integrations/notion.svg")} alt="Notion" width={32} height={32} />,
    keywords: ["notion", "notes", "wiki", "documentation", "docs", "database", "knowledge base", "writing"],
  },
  {
    key: "linear",
    label: "Linear",
    icon: <img src={publicAsset("/images/integrations/linear-light-logo.svg")} alt="Linear" width={32} height={32} />,
    keywords: ["linear", "sprint", "issue", "ticket", "project management", "backlog", "roadmap", "kanban"],
  },
  {
    key: "github",
    label: "GitHub",
    icon: <GitHubLogo size={32} />,
    keywords: ["github", "code", "programming", "repo", "pull request", "commit", "developer", "engineering", "software"],
  },
  {
    key: "slack",
    label: "Slack",
    icon: <SlackLogo size={32} />,
    keywords: ["slack", "team", "channel", "messaging", "chat", "standup", "communication"],
  },
  {
    key: "gmail",
    label: "Gmail",
    icon: <img src={publicAsset("/images/integrations/gmail.svg")} alt="Gmail" width={32} height={32} />,
    keywords: ["gmail", "email", "inbox", "newsletter", "outreach", "correspondence"],
  },
  {
    key: "figma",
    label: "Figma",
    icon: <img src={publicAsset("/images/integrations/figma.svg")} alt="Figma" width={32} height={32} />,
    keywords: ["figma", "design", "ui", "ux", "wireframe", "prototype", "mockup", "visual"],
  },
  {
    key: "outlook",
    label: "Outlook",
    icon: <img src={publicAsset("/images/integrations/outlook.png")} alt="Outlook" width={32} height={32} />,
    keywords: ["outlook", "microsoft", "office", "teams", "enterprise"],
  },
  {
    key: "google-drive",
    label: "Google Drive",
    icon: <img src={publicAsset("/images/integrations/google-drive.svg")} alt="Google Drive" width={32} height={32} />,
    keywords: ["drive", "files", "storage", "documents", "spreadsheet", "folder", "share", "upload"],
  },
];

/**
 * Analyse uploaded brain-import context to pick the best second OAuth tool.
 * Returns a tool from REACH_TOOLS. Falls back to a deterministic random pick
 * seeded from `characterId` when no context was uploaded or no keywords match.
 */
function pickSecondReachTool(fileContent: string | null, characterId: string): ReachTool {
  if (fileContent) {
    const lower = fileContent.toLowerCase();
    let best: ReachTool | null = null;
    let bestScore = 0;
    for (const tool of REACH_TOOLS) {
      const score = tool.keywords.reduce((n, kw) => {
        // Count occurrences of each keyword (case-insensitive, whole-word-ish)
        const re = new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi");
        return n + (lower.match(re)?.length ?? 0);
      }, 0);
      if (score > bestScore) {
        bestScore = score;
        best = tool;
      }
    }
    if (best) return best;
  }

  // Deterministic pseudo-random pick seeded from character id
  let hash = 0;
  for (let i = 0; i < characterId.length; i++) {
    hash = (hash * 31 + characterId.charCodeAt(i)) | 0;
  }
  return REACH_TOOLS[Math.abs(hash) % REACH_TOOLS.length];
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function ReachChoice({
  character,
  secondTool,
  onPick,
  onBack,
}: {
  character: CastCharacter;
  secondTool: ReachTool;
  onPick: (connected: string[]) => void;
  onBack: () => void;
}) {
  const [connected, setConnected] = useState<Set<string>>(new Set());
  const [celebrating, setCelebrating] = useState(false);
  const [showCelebration, setShowCelebration] = useState(false);

  const avatarColor = useMemo(() => {
    const { color } = resolveDefinitions(COMPONENTS, character.bodyShape, character.eyeStyle, character.color);
    return color.hex;
  }, [character.bodyShape, character.eyeStyle, character.color]);

  const [confettiPieces] = useState(() =>
    Array.from({ length: 40 }, () => ({
      left: `${Math.random() * 100}%`,
      delay: `${Math.random() * 0.5}s`,
      duration: `${1 + Math.random() * 1.5}s`,
      opacity: 0.4 + Math.random() * 0.6,
    })),
  );

  const tools = useMemo(
    () => [
      {
        key: "google-calendar",
        label: "Google Calendar",
        icon: <img src={publicAsset("/images/integrations/google-calendar.svg")} alt="Google Calendar" width={32} height={32} />,
      },
      { key: secondTool.key, label: secondTool.label, icon: secondTool.icon },
    ],
    [secondTool],
  );

  function handleConnect(key: string) {
    setConnected((prev) => {
      const next = new Set(prev);
      next.add(key);
      return next;
    });
  }

  function handleContinue() {
    if (connected.size > 0) {
      setCelebrating(true);
      setShowCelebration(true);
      setTimeout(() => {
        onPick([...connected]);
      }, 2200);
    } else {
      onPick([]);
    }
  }

  return (
    <motion.div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        height: "100dvh",
        padding: "0 20px",
      }}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
    >
      <button className="cast-back" onClick={onBack} aria-label="Back">
        ‹
      </button>

      <div style={{ width: 140, height: 140, marginBottom: 28 }}>
        <BlinkingAvatar character={character} />
      </div>

      <div className="cast-thisthat">
        <motion.div
          className="cast-thisthat__group"
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, ease: "easeOut" }}
          style={{ gap: 0 }}
        >
          <p className="cast-thisthat__title" style={{ marginBottom: 56 }}>
            Where do I start working?
          </p>

          <AnimatePresence mode="wait">
            {!celebrating ? (
              <motion.div
                key="reach-tools"
                exit={{ opacity: 0, y: -12 }}
                transition={{ duration: 0.25, ease: "easeIn" }}
              >
                <div className="cast-thisthat__row">
                  {tools.map((tool) => {
                    const isConnected = connected.has(tool.key);
                    return (
                      <motion.button
                        key={tool.key}
                        className="cast-vs"
                        onClick={() => !isConnected && handleConnect(tool.key)}
                        whileHover={isConnected ? undefined : { y: -6 }}
                        whileTap={isConnected ? undefined : { scale: 0.97 }}
                        style={{
                          flexDirection: "column",
                          gap: 10,
                          position: "relative",
                          opacity: isConnected ? 0.85 : 1,
                          cursor: isConnected ? "default" : "pointer",
                        }}
                      >
                        {tool.icon}
                        {tool.label}
                        {isConnected && (
                          <span
                            className="cast-brain-connected__tag"
                            style={{
                              color: avatarColor,
                              background: `color-mix(in srgb, ${avatarColor} 16%, transparent)`,
                              position: "absolute",
                              top: 8,
                              right: 8,
                            }}
                          >
                            Connected
                          </span>
                        )}
                      </motion.button>
                    );
                  })}
                </div>

                <button
                  type="button"
                  className="cast-customize__continue"
                  style={{ width: "100%", marginTop: 14 }}
                  onClick={handleContinue}
                >
                  {connected.size > 0 ? "Continue →" : "Skip for now →"}
                </button>
              </motion.div>
            ) : (
              <motion.div
                key="reach-connected"
                className="cast-brain-connected"
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ duration: 0.35, ease: "easeOut" }}
              >
                <motion.span
                  className="cast-brain-connected__credits"
                  style={{
                    color: avatarColor,
                    background: `color-mix(in srgb, ${avatarColor} 16%, transparent)`,
                  }}
                  initial={{ opacity: 0, scale: 0.5 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ type: "spring", stiffness: 400, damping: 18, delay: 0.3 }}
                >
                  +25 credits
                </motion.span>
                <div className="cast-brain-connected__card">
                  {tools
                    .filter((t) => connected.has(t.key))
                    .map((t) => (
                      <span key={t.key} style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                        {t.icon}
                        <span className="cast-brain-connected__label">{t.label}</span>
                      </span>
                    ))}
                  <span
                    className="cast-brain-connected__tag"
                    style={{
                      color: avatarColor,
                      background: `color-mix(in srgb, ${avatarColor} 16%, transparent)`,
                    }}
                  >
                    Connected
                  </span>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {showCelebration && (
            <motion.div
              className="cast-celebration"
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ type: "spring", stiffness: 300, damping: 20 }}
            >
              <div className="cast-celebration__confetti">
                {confettiPieces.map((p, i) => (
                  <span key={i} className="cast-celebration__piece" style={{
                    left: p.left,
                    animationDelay: p.delay,
                    animationDuration: p.duration,
                    background: avatarColor,
                    opacity: p.opacity,
                  }} />
                ))}
              </div>
            </motion.div>
          )}
        </motion.div>
      </div>
    </motion.div>
  );
}

// ---------------------------------------------------------------------------
// EmailChoice — "Setup my email so I can reach you" — handle + subdomain
// ---------------------------------------------------------------------------

function sanitizeHandle(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9-]/g, "").replace(/^-+|-+$/g, "");
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function EmailChoice({
  character,
  name,
  onPick,
  onBack,
}: {
  character: CastCharacter;
  name: string;
  onPick: (localPart: string) => void;
  onBack: () => void;
}) {
  const [local, setLocal] = useState(() => {
    const base = sanitizeHandle(name) || sanitizeHandle(character.id);
    return `hi@${base}`;
  });

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    // Allow letters, numbers, hyphens, dots, and a single @
    const raw = e.target.value.toLowerCase().replace(/[^a-z0-9@.\-]/g, "");
    setLocal(raw);
  }

  return (
    <motion.div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        height: "100dvh",
        padding: "0 20px",
      }}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
    >
      <button className="cast-back" onClick={onBack} aria-label="Back">
        ‹
      </button>

      <div style={{ width: 140, height: 140, marginBottom: 28 }}>
        <BlinkingAvatar character={character} />
      </div>

      <div className="cast-thisthat">
        <motion.div
          className="cast-thisthat__group"
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, ease: "easeOut" }}
          style={{ gap: 0 }}
        >
          <p className="cast-thisthat__title" style={{ marginBottom: 40 }}>
            Setup my email so I can reach you
          </p>

          <div className="cast-handle">
            <div className="cast-handle__field">
              <input
                className="cast-handle__input"
                type="text"
                value={local}
                onChange={handleChange}
                placeholder="hi@your-name"
                autoFocus
                spellCheck={false}
                autoComplete="off"
                style={{ width: `${Math.max(1, local.length || 12)}ch` }}
              />
              <span className="cast-handle__suffix">.vellum.me</span>
            </div>
          </div>

          <button
            type="button"
            className="cast-customize__continue"
            style={{ width: "100%", marginTop: 14 }}
            onClick={() => onPick(local.trim())}
          >
            {local.trim() ? "Continue →" : "Skip for now →"}
          </button>
        </motion.div>
      </div>
    </motion.div>
  );
}

// ---------------------------------------------------------------------------
// HandoffScreen — transition screen before dropping into chat sandbox
// ---------------------------------------------------------------------------

const TOOL_TASKS: Record<string, string[]> = {
  "google-calendar": ["Check my schedule for today", "Block focus time this week"],
  "notion": ["Summarize my recent Notion updates", "Create a weekly planner page"],
  "linear": ["Show my open Linear issues", "Draft a sprint summary"],
  "github": ["Review my open pull requests", "Summarize recent commits"],
  "slack": ["Catch me up on unread Slack messages", "Draft a standup update"],
  "gmail": ["Summarize my unread emails", "Draft a follow-up email"],
  "figma": ["List recent Figma file changes", "Prepare design review notes"],
  "outlook": ["Check my Outlook calendar for today", "Summarize flagged emails"],
  "google-drive": ["Find my most recent shared docs", "Organize my Drive files"],
};

const FALLBACK_TASKS = [
  "Draft a daily plan for me",
  "Help me write a professional email",
  "Summarize a document for me",
  "Create a to-do list for this week",
  "Research a topic and brief me",
];

function deriveTaskSuggestions(memories: [string, string][]): string[] {
  const tasks: string[] = [];
  const memMap = new Map(memories);

  // Pull tasks from connected tools
  const reachText = memMap.get("reach") ?? "";
  if (reachText.startsWith("Connected:")) {
    const toolNames = reachText.replace("Connected: ", "").split(", ");
    for (const toolName of toolNames) {
      // Find key by label
      const key =
        toolName === "Google Calendar"
          ? "google-calendar"
          : toolName.toLowerCase().replace(/\s+/g, "-");
      const pool = TOOL_TASKS[key];
      if (pool) tasks.push(pool[Math.floor(Math.random() * pool.length)]);
    }
  }

  // If brain was imported, add a related task
  const brainText = memMap.get("brain") ?? "";
  if (brainText.includes("Import from:")) {
    tasks.push("Pick up where I left off with my previous conversations");
  }

  // Fill remaining slots from fallbacks
  const seen = new Set(tasks);
  for (const t of FALLBACK_TASKS) {
    if (tasks.length >= 3) break;
    if (!seen.has(t)) {
      tasks.push(t);
      seen.add(t);
    }
  }

  return tasks.slice(0, 3);
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function HandoffScreen({
  character,
  memories,
  onComplete,
}: {
  character: CastCharacter;
  memories: [string, string][];
  onComplete: () => void;
}) {
  const [showCta, setShowCta] = useState(false);
  const onCompleteRef = useRef(onComplete);
  useEffect(() => { onCompleteRef.current = onComplete; });

  const tasks = useMemo(() => deriveTaskSuggestions(memories), [memories]);

  useEffect(() => {
    const ctaTimer = window.setTimeout(() => setShowCta(true), 1800);
    return () => clearTimeout(ctaTimer);
  }, []);

  return (
    <motion.div
      className="cast-handoff"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.4 }}
    >
      <div style={{ width: 200, height: 200, marginBottom: 32 }}>
        <BlinkingAvatar character={character} />
      </div>
      <h2 className="cast-handoff__heading">
        Here's what I found I can take care of for you today
      </h2>
      <ul className="cast-handoff__tasks">
        {tasks.map((task, i) => (
          <motion.li
            key={task}
            className="cast-handoff__task"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, delay: 0.4 + i * 0.2 }}
          >
            {task}
          </motion.li>
        ))}
      </ul>
      <AnimatePresence>
        {showCta && (
          <motion.button
            className="cast-handoff__cta"
            onClick={() => onCompleteRef.current()}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
          >
            Let's go &rarr;
          </motion.button>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

// ---------------------------------------------------------------------------
// RotatingWord — cycles through words with a slide-up animation
// ---------------------------------------------------------------------------

function RotatingWord({ words }: { words: string[] }) {
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
      <span className="cast-login__rotating-sizer" aria-hidden>{longest}.</span>
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
// PreambleScreen — story introduction after login, before character selection
// ---------------------------------------------------------------------------

function preambleGreeting(firstName: string) {
  return `Nice to meet you, ${firstName}`;
}

function preambleLines() {
  return [
    "I\u2019m your new AI assistant. I can live in your browser, on your computer, in Gmail, Slack, or anywhere else you work.",
    "I\u2019ll learn how you like things done and get better every day.",
    "First, let\u2019s figure out who I am.",
  ];
}

/**
 * Preamble grid — a single cohesive grid anchored to each bottom corner.
 * Every cell is the same size; some cells have a character outline, others are empty.
 * The grid lines create the structure; characters just inhabit some cells.
 */
const GRID_COLS = 3;
const GRID_ROWS = 5;
const GRID_CELL = 110;

// Grid layout: [row][col] = bodyShape or null. Row 0 = bottom.
const LEFT_GRID: (string | null)[][] = [
  ["sprout", "star",  "cloud"],
  ["blob",   "ghost", null   ],
  ["ninja",  null,    "burst"],
  [null,     "flower", null  ],
  ["urchin", null,    null   ],
];

const RIGHT_GRID: (string | null)[][] = [
  ["stack",  "burst", "blob"  ],
  [null,     "cloud", "flower"],
  ["star",   "ninja", null    ],
  [null,     "ghost", "sprout"],
  [null,     null,    "urchin"],
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
    <div
      className={`cast-preamble__grid cast-preamble__grid--${side}`}
      style={{ width, height }}
    >
      {/* Grid lines layer (masked with gradient) */}
      <div className={`cast-preamble__lines cast-preamble__lines--${side}`}>
        <svg className="cast-preamble__gridlines" viewBox={`0 0 ${width} ${height}`} width={width} height={height}>
          {Array.from({ length: GRID_COLS + 1 }, (_, i) => {
            if (side === "left" && i === GRID_COLS) return null;
            if (side === "right" && i === 0) return null;
            return <line key={`v${i}`} x1={i * GRID_CELL} y1={0} x2={i * GRID_CELL} y2={height} stroke={GRID_LINE_COLOR} strokeWidth={1} />;
          })}
          {Array.from({ length: GRID_ROWS + 1 }, (_, i) => {
            if (i === 0) return null;
            return <line key={`h${i}`} x1={0} y1={i * GRID_CELL} x2={width} y2={i * GRID_CELL} stroke={GRID_LINE_COLOR} strokeWidth={1} />;
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

function SetupShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="cast-setup-shell">
      <div className="cast-preamble__topbar">
        <img
          src={publicAsset("/images/vellum-pill.svg")}
          alt="Vellum"
          width={100}
          height={36}
        />
        <span className="cast-preamble__setup-label">Setting up your assistant</span>
      </div>
      <PreambleBoxes />
      <div className="cast-setup-shell__content">
        <AnimatePresence mode="wait">
          {children}
        </AnimatePresence>
      </div>
    </div>
  );
}

/** Green rounded square with "?" — preamble speaker placeholder. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function GhostAvatar() {
  return (
    <span className="cast-vn__ghost">
      <span className="cast-vn__ghost-q">?</span>
    </span>
  );
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const LOADING_MESSAGES = [
  "Warming up\u2026",
  "Getting things ready\u2026",
  "Almost there\u2026",
];

function PreambleScreen({ firstName, onContinue }: { firstName: string; onContinue: () => void }) {
  const greeting = useMemo(() => preambleGreeting(firstName), [firstName]);
  const lines = useMemo(() => preambleLines(), []);
  const totalLen = useMemo(() => lines.reduce((n, l) => n + l.length, 0), [lines]);
  const [charCount, setCharCount] = useState(0);
  const typed = charCount >= totalLen;

  useEffect(() => {
    if (typed) return;
    const id = window.setTimeout(() => setCharCount((c) => c + 1), 50);
    return () => clearTimeout(id);
  }, [charCount, typed]);

  function handleClick() {
    if (!typed) {
      setCharCount(totalLen);
      return;
    }
    onContinue();
  }

  let remaining = charCount;
  const revealed: string[] = [];
  const reached: boolean[] = [];
  for (const line of lines) {
    reached.push(remaining > 0);
    revealed.push(remaining > 0 ? line.slice(0, remaining) : "");
    remaining -= line.length;
  }
  const typingLineIdx = typed ? -1 : revealed.findIndex((r, i) => r.length < lines[i].length && reached[i]);

  // Typewriter for the greeting heading
  const [greetCharCount, setGreetCharCount] = useState(0);
  const greetTyped = greetCharCount >= greeting.length;

  useEffect(() => {
    if (greetTyped) return;
    const id = window.setTimeout(() => setGreetCharCount((c) => c + 1), 65);
    return () => clearTimeout(id);
  }, [greetCharCount, greetTyped]);

  // Don't start body typewriter until greeting is done
  const bodyStarted = greetTyped;

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
        {/* Invisible full content to reserve final dimensions */}
        <div aria-hidden className="cast-vn__bottom" style={{ visibility: "hidden" }}>
          <h2 className="cast-about__heading" style={{ textAlign: "left" }}>{greeting}</h2>
          {lines.map((line, i) => (
            <p key={i} className="cast-vn__text">{line}</p>
          ))}
          <span className="cast-vn__advance">Next &#9660;</span>
        </div>
        {/* Visible typed overlay */}
        <div className="cast-vn__bottom" style={{ position: "absolute", inset: 0 }}>
          <h2 className="cast-about__heading" style={{ textAlign: "left" }}>
            {greeting.slice(0, greetCharCount)}
            {!greetTyped && <span className="cast-vn__cursor">|</span>}
          </h2>
          {bodyStarted && lines.map((line, i) => {
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


// ---------------------------------------------------------------------------
// VNDialogueFlow — unified Visual Novel dialogue replacing preamble, tone,
// reach, and handoff as one bottom-anchored dialogue scene.
// ---------------------------------------------------------------------------

interface VNDialogueFlowProps {
  character: CastCharacter;
  name: string;
  userName: string;
  brainFileContent: string | null;
  memories: [string, string][];
  onTonePicked: (value: "fast" | "deep") => void;
  onReachPicked: (connected: string[], creditsEarned: number) => void;
  onComplete: () => void;
  onBack: () => void;
  embedded?: boolean;
}

type VNStep =
  | { kind: "tone" }
  | { kind: "tone-react"; value: "fast" | "deep" }
  | { kind: "reach" }
  | { kind: "reach-react"; connected: number }
  | { kind: "handoff" }
  | { kind: "handoff-ready" };

function vnDialogueText(step: VNStep, _name: string): string {
  if (step.kind === "tone") return "How do I talk?";
  if (step.kind === "tone-react") {
    return step.value === "fast"
      ? "Short and sharp. Got it."
      : "I\u2019ll take my time and explain everything.";
  }
  if (step.kind === "reach") return "Where should I start working?";
  if (step.kind === "reach-react") {
    return step.connected > 0
      ? "Nice, we\u2019re connected. This is going to be good."
      : "No worries, we can set those up later.";
  }
  if (step.kind === "handoff-ready") return "I put together a workspace for you. Go take a look.";
  return "I did some research while we were talking. One sec\u2026";
}

function VNDialogueFlow({
  character,
  name,
  userName,
  brainFileContent,
  memories: _memories,
  onTonePicked,
  onReachPicked,
  onComplete,
  onBack,
  embedded,
}: VNDialogueFlowProps) {
  const [step, setStep] = useState<VNStep>({ kind: "tone" });
  const [charCount, setCharCount] = useState(0);
  const [typed, setTyped] = useState(false);
  const [tonePick, setTonePick] = useState<"left" | "right" | null>(null);
  const [reachConnected, setReachConnected] = useState<Set<string>>(new Set());
  const [loadingStepIdx, setLoadingStepIdx] = useState(0);
  const loadingSteps = useMemo(() => [
    `Learning about ${userName}\u2026`,
    "Reading public profiles\u2026",
    "Looking for hobbies\u2026",
    "Checking work history\u2026",
    "Analyzing communication style\u2026",
    "Mapping daily routines\u2026",
    "Finding relevant tools\u2026",
    "Setting up integrations\u2026",
    "Configuring preferences\u2026",
    "Building shortcuts\u2026",
    "Optimizing workflows\u2026",
    "Preparing suggestions\u2026",
    "Personalizing the workspace\u2026",
    "Final touches\u2026",
  ], [userName]);

  const onCompleteRef = useRef(onComplete);
  useEffect(() => { onCompleteRef.current = onComplete; });

  const text = vnDialogueText(step, name);

  // Reach tools (same logic as ReachChoice)
  const secondTool = useMemo(
    () => pickSecondReachTool(brainFileContent, character.id),
    [brainFileContent, character.id],
  );
  const reachTools = useMemo(
    () => [
      {
        key: "google-calendar",
        label: "Google Calendar",
        icon: <img src={publicAsset("/images/integrations/google-calendar.svg")} alt="Google Calendar" width={32} height={32} />,
      },
      { key: secondTool.key, label: secondTool.label, icon: secondTool.icon },
    ],
    [secondTool],
  );

  // --- Typewriter effect ---
  useEffect(() => {
    if (typed) return;
    if (charCount < text.length) {
      const id = window.setTimeout(() => setCharCount((c) => c + 1), 18);
      return () => clearTimeout(id);
    }
    setTyped(true);
  }, [charCount, text, typed]);

  // Reset typewriter on step change
  const stepKey = step.kind;
  useEffect(() => {
    setCharCount(0);
    setTyped(false);
  }, [stepKey]);

  // Cycle through loading steps during handoff
  useEffect(() => {
    if (step.kind !== "handoff" || !typed) return;
    if (loadingStepIdx >= loadingSteps.length) {
      // Loading done — advance to handoff-ready so the new text types out
      setStep({ kind: "handoff-ready" });
      return;
    }
    const id = window.setTimeout(() => setLoadingStepIdx((i) => i + 1), 1500);
    return () => clearTimeout(id);
  }, [step.kind, typed, loadingStepIdx, loadingSteps.length]);

  // Auto-advance from react steps after typewriter completes
  useEffect(() => {
    if (!typed) return;
    if (step.kind === "tone-react") {
      const id = window.setTimeout(() => setStep({ kind: "reach" }), 1800);
      return () => clearTimeout(id);
    }
    if (step.kind === "reach-react") {
      const id = window.setTimeout(() => setStep({ kind: "handoff" }), 1800);
      return () => clearTimeout(id);
    }
    if (step.kind === "handoff-ready") {
      const id = window.setTimeout(() => onCompleteRef.current(), 2200);
      return () => clearTimeout(id);
    }
  }, [step.kind, typed]);

  // --- Tone choice ---
  function handleToneChoice(side: "left" | "right") {
    if (tonePick) return;
    setTonePick(side);
    const value = side === "left" ? "fast" : "deep";
    onTonePicked(value);
    setTimeout(() => setStep({ kind: "tone-react", value }), 200);
  }

  // --- Reach connect ---
  function handleReachConnect(key: string, e: React.MouseEvent) {
    e.stopPropagation();
    setReachConnected((prev) => {
      const next = new Set(prev);
      next.add(key);
      return next;
    });
  }

  function handleReachContinue(e: React.MouseEvent) {
    e.stopPropagation();
    const connected = [...reachConnected];
    onReachPicked(connected, connected.length > 0 ? 25 : 0);
    setStep({ kind: "reach-react", connected: connected.length });
  }

  const vnCls = embedded ? "cast-vn cast-vn--top cast-vn--embedded" : "cast-vn cast-vn--top";

  const vnContent = (
    <div className={vnCls}>
      {/* Back button */}
      <button className="cast-back" onClick={(e) => { e.stopPropagation(); onBack(); }} aria-label="Back">
        ‹
      </button>

      {/* Top-anchored dialogue area */}
      <div className="cast-vn__top">
        {/* Avatar + name header */}
        <div className="cast-vn__header">
          <div className="cast-vn__header-avatar">
            <BlinkingAvatar character={character} />
          </div>
          <span className="cast-vn__speaker">{name}</span>
        </div>

        {/* Dialogue box */}
        <div className="cast-vn__box">
          <p className="cast-vn__text">
            {text.slice(0, charCount)}
            {!typed && <span className="cast-vn__cursor">|</span>}
          </p>
        </div>

        {/* Tone choices */}
        {step.kind === "tone" && typed && (
          <div className="cast-vn__choices">
            {(["left", "right"] as const).map((side) => {
              const label = side === "left" ? "Get to the point" : "Explain everything";
              const isPicked = tonePick === side;
              const isUnpicked = tonePick !== null && !isPicked;
              return (
                <motion.button
                  key={side}
                  className={`cast-vs${isPicked ? " cast-vs--selected" : ""}`}
                  onClick={(e) => { e.stopPropagation(); handleToneChoice(side); }}
                  animate={
                    isUnpicked
                      ? { opacity: 0.4 }
                      : { opacity: 1 }
                  }
                  transition={{ duration: 0.3, ease: "easeOut" }}
                  whileHover={tonePick ? undefined : { y: -6 }}
                  whileTap={tonePick ? undefined : { scale: 0.97 }}
                >
                  {label}
                </motion.button>
              );
            })}
          </div>
        )}

        {/* Reach tool cards */}
        {step.kind === "reach" && typed && (
          <>
            <div className="cast-vn__choices">
              {reachTools.map((tool) => {
                const isConnected = reachConnected.has(tool.key);
                return (
                  <motion.button
                    key={tool.key}
                    className="cast-vs"
                    onClick={(e) => !isConnected && handleReachConnect(tool.key, e)}
                    whileHover={isConnected ? undefined : { y: -6 }}
                    whileTap={isConnected ? undefined : { scale: 0.97 }}
                    style={{
                      flexDirection: "column",
                      gap: 10,
                      position: "relative",
                      opacity: isConnected ? 0.85 : 1,
                      cursor: isConnected ? "default" : "pointer",
                    }}
                  >
                    {tool.icon}
                    {tool.label}
                    {isConnected && (
                      <span
                        className="cast-brain-connected__tag"
                        style={{
                          color: "var(--content-default)",
                          background: "color-mix(in srgb, var(--content-default) 10%, transparent)",
                          position: "absolute",
                          top: 8,
                          right: 8,
                        }}
                      >
                        Connected
                      </span>
                    )}
                  </motion.button>
                );
              })}
            </div>
            <button
              type="button"
              className="cast-vn__advance"
              onClick={handleReachContinue}
            >
              Next &#9660;
            </button>
          </>
        )}

        {/* Handoff loading states */}
        {step.kind === "handoff" && typed && (
          <div className="cast-vn__loading">
            <div className="cast-vn__loading-indicator">
              <span className="cast-vn__loading-dot" />
              <span className="cast-vn__loading-dot" />
              <span className="cast-vn__loading-dot" />
            </div>
            <AnimatePresence mode="wait">
              <motion.p
                key={loadingStepIdx}
                className="cast-vn__loading-text"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.25 }}
              >
                {loadingSteps[loadingStepIdx]}
              </motion.p>
            </AnimatePresence>
          </div>
        )}
      </div>

    </div>
  );

  if (embedded) {
    return (
      <motion.div
        key="dialogue"
        initial={{ opacity: 0, y: 40 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -40 }}
        transition={{ duration: 0.4, ease: "easeOut" }}
        style={{ width: "100%", height: "100%" }}
      >
        {vnContent}
      </motion.div>
    );
  }

  return vnContent;
}

// ---------------------------------------------------------------------------
// LoginScreen — sign-in page + inline "about you" dialog form
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const ABOUT_ROLES = [
  "Software Engineer",
  "Product Lead",
  "Designer",
  "GTM Engineer",
  "Finance Ops",
  "Household Manager",
  "Founder",
  "Other",
];

function LoginScreen({ onContinue }: { onContinue: (firstName: string) => void }) {
  const [loggedIn, setLoggedIn] = useState(false);
  const [firstName, setFirstName] = useState("Anita");
  const [lastName, setLastName] = useState("Kirkovska");
  const [role, setRole] = useState("");
  const [revealed, setRevealed] = useState(2); // name fields pre-filled from OAuth
  const [exiting, setExiting] = useState(false);

  // Reveal continue button when role gets content
  useEffect(() => {
    if (revealed < 3 && role.length > 0) setRevealed(3);
  }, [role, revealed]);

  const showLastName = true;
  const showRole = true;
  const showContinue = true;

  function handleLogin() {
    if (loggedIn) return;
    setLoggedIn(true);
  }

  function handleContinue() {
    if (exiting || !firstName.trim() || !lastName.trim() || !role.trim()) return;
    setExiting(true);
    setTimeout(() => onContinue(firstName.trim()), 450);
  }

  const buttons = [
    { icon: <GoogleLogo size={18} />, label: "Continue with Google" },
    { icon: <AppleLogo size={18} />, label: "Continue with Apple" },
    {
      icon: (
        <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <rect x="2" y="4" width="20" height="16" rx="2" />
          <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
        </svg>
      ),
      label: "Continue with Email",
    },
  ] as const;

  return (
    <motion.div
      className="cast-login"
      initial={{ opacity: 0 }}
      animate={exiting ? { opacity: 0 } : { opacity: 1 }}
      transition={{ duration: exiting ? 0.4 : 0.5 }}
    >
      {/* ---- Left column: brand + form ---- */}
      <div className="cast-login__left">
        <motion.div
          className="cast-login__logo"
          initial={{ opacity: 0 }}
          animate={exiting ? { opacity: 0 } : { opacity: 1 }}
          transition={{ duration: 0.4, delay: exiting ? 0 : 0.1 }}
        >
          <img
            src={publicAsset("/vellum-logo-white.svg")}
            alt="Vellum"
            width={82}
            height={25}
          />
        </motion.div>

        <div className="cast-login__form">
          <AnimatePresence mode="wait">
            {!loggedIn ? (
              <motion.div
                key="signup"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0, y: -10 }}
                transition={{ duration: 0.3 }}
              >
                <motion.h1
                  className="cast-login__title"
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.4, delay: 0.2 }}
                >
                  Meet your own<br />
                  <RotatingWord words={["Personal Intelligence", "Software Engineer", "Finance Ops", "Household Manager", "GTM Engineer", "Product Lead"]} />
                </motion.h1>
                <motion.p
                  className="cast-login__subtitle"
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.35, delay: 0.3 }}
                >
                  The most powerful assistant that can handle your work and life admin tasks.
                </motion.p>

                <div className="cast-login__buttons">
                  {buttons.map((btn, i) => (
                    <motion.button
                      key={btn.label}
                      className="cast-login__btn"
                      onClick={handleLogin}
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.3, delay: 0.38 + i * 0.08 }}
                    >
                      {i === 0 && <span className="cast-login__tag">Most used</span>}
                      {btn.icon}
                      {btn.label}
                    </motion.button>
                  ))}
                </div>

                <motion.p
                  className="cast-login__footer"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ duration: 0.3, delay: 0.65 }}
                >
                  Don't have an account?{" "}
                  <button className="cast-login__link" onClick={handleLogin}>
                    Sign up
                  </button>
                </motion.p>

                <motion.button
                  className="cast-login__download"
                  onClick={handleLogin}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ duration: 0.3, delay: 0.75 }}
                >
                  <AppleLogo size={16} />
                  Download for macOS
                </motion.button>
              </motion.div>
            ) : (
              <motion.div
                key="about"
                className="cast-about__thread"
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.4 }}
              >
                <h2 className="cast-about__heading">Almost there,<br />one more detail</h2>

                <motion.div
                  className="cast-about__step"
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.35, delay: 0.15 }}
                >
                  <span className="cast-about__label">What should I call you? <span className="cast-about__req">*</span></span>
                  <input
                    className="cast-about__input"
                    type="text"
                    placeholder="First name"
                    value={firstName}
                    onChange={(e) => setFirstName(e.target.value)}
                    autoFocus
                  />
                </motion.div>

                {showLastName && (
                  <motion.div
                    className="cast-about__step"
                    initial={{ opacity: 0, y: 12 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.35 }}
                  >
                    <span className="cast-about__label">And your last name? <span className="cast-about__req">*</span></span>
                    <input
                      className="cast-about__input"
                      type="text"
                      placeholder="Last name"
                      value={lastName}
                      onChange={(e) => setLastName(e.target.value)}
                    />
                  </motion.div>
                )}

                {showRole && (
                  <motion.div
                    className="cast-about__step"
                    initial={{ opacity: 0, y: 12 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.35 }}
                  >
                    <span className="cast-about__label">Your role <span className="cast-about__req">*</span></span>
                    <input
                      className="cast-about__input"
                      type="text"
                      placeholder="e.g. Software Engineer"
                      value={role}
                      onChange={(e) => setRole(e.target.value)}
                    />
                  </motion.div>
                )}

                {showContinue && (
                  <motion.div
                    className="cast-about__step"
                    initial={{ opacity: 0, y: 12 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.35 }}
                  >
                    <button
                      className="cast-about__continue"
                      onClick={handleContinue}
                      disabled={!firstName.trim() || !lastName.trim() || !role.trim()}
                    >
                      Continue &rarr;
                    </button>
                  </motion.div>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      {/* ---- Right column: video ---- */}
      <motion.div
        className="cast-login__right"
        initial={{ opacity: 0 }}
        animate={exiting ? { opacity: 0 } : { opacity: 1 }}
        transition={{ duration: 0.6, delay: exiting ? 0 : 0.15 }}
        aria-hidden
      >
        <video
          className="cast-login__video"
          src={publicAsset("/vellum-scene-cut.mp4")}
          autoPlay
          loop
          muted
          playsInline
        />
      </motion.div>
    </motion.div>
  );
}

// ---------------------------------------------------------------------------
// InteractiveCastFlow — extracted from CastPage, no cast-stage wrapper, no
// chat/boost phases. Proof's endpoint CTA fires onComplete instead.
// ---------------------------------------------------------------------------

function InteractiveCastFlow({ onComplete }: { onComplete: (data: CastCompletionData) => void }) {
  const panelRef = useRef<HTMLDivElement>(null);

  const [phase, setPhase] = useState<CastPhase>("login");
  const [userFirstName, setUserFirstName] = useState("");
  const [selected, setSelected] = useState<CastCharacter | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const [customizing, setCustomizing] = useState(false);
  const [brainFileContent, setBrainFileContent] = useState<string | null>(null);
  const [earnedCredits, setEarnedCredits] = useState(0);

  const [boxes, setBoxes] = useState(() => {
    const { w, h } = win();
    return { top: topBoxFor(w, h), w };
  });

  const convo = useCastConversation();
  const [jobs, setJobs] = useState<JobKey[]>([]);
  const [_jobEdges, setJobEdges] = useState<Record<string, Edge>>({});
  const [rathers, setRathers] = useState<RatherKey[]>([]);
  const [style, setStyle] = useState<StyleProfile>({});
  const [_mime, setMime] = useState<MimeState | null>(null);
  const [_ratherSent, setRatherSent] = useState(false);

  // Memory list — accumulates across the tone/vibe/reach This/That phases.
  // Entries are [step, text] tuples keyed by step so re-picks overwrite.
  const [memories, setMemories] = useState<[string, string][]>([]);
  const [typingStep, setTypingStep] = useState<string | null>(null);
  const pendingPhaseRef = useRef<CastPhase | null>(null);

  function addMemory(step: string, text: string, nextPhase: CastPhase) {
    setMemories((prev) => [...prev.filter(([s]) => s !== step), [step, text]]);
    setTypingStep(step);
    pendingPhaseRef.current = nextPhase;
  }

  function recordMemory(step: string, text: string) {
    setMemories((prev) => [...prev.filter(([s]) => s !== step), [step, text]]);
  }

  function onMemoryTyped() {
    setTypingStep(null);
    if (pendingPhaseRef.current) {
      setPhase(pendingPhaseRef.current);
      pendingPhaseRef.current = null;
    }
  }

  const tapRef = useRef(0);
  const mimeTimer = useRef<number | undefined>(undefined);
  const clearBeatTimers = () => {
    clearTimeout(mimeTimer.current);
  };

  useEffect(() => {
    const onResize = () => {
      const { w, h } = win();
      setBoxes({ top: topBoxFor(w, h), w });
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      clearBeatTimers();
    };
  }, []);

  const name = selected ? (names[selected.id] ?? selected.name) : "";
  const leftPanelBox: Rect = { ...boxes.top, left: boxes.w / 4 - boxes.top.size / 2 };
  const assistantId = useAssistantSelectionStore.use.activeAssistantId();

  const resume: StarterResume | null = selected
    ? {
        bodyShape: selected.bodyShape,
        eyeStyle: selected.eyeStyle,
        color: selected.color,
        name,
      }
    : null;

  function chooseStarter(char: CastCharacter, chosenName: string) {
    setSelected(char);
    setNames((prev) => ({ ...prev, [char.id]: chosenName }));
    convo.seedGreeting(chosenName);
    addMemory("face", `Look & feel: ${chosenName}`, "dialogue");
    setPhase("dialogue");
  }

  function reopenCustomize() {
    clearBeatTimers();
    convo.reset();
    setJobs([]);
    setJobEdges({});
    setRathers([]);
    setStyle({});
    setMime(null);
    setRatherSent(false);
    setMemories([]);
    setTypingStep(null);
    setBrainFileContent(null);
    setEarnedCredits(0);
    pendingPhaseRef.current = null;
    setPhase("starter");
  }

  function _toggleJob(key: JobKey) {
    const adding = !jobs.includes(key);
    const next = adding ? [...jobs, key] : jobs.filter((k) => k !== key);
    setJobs(next);
    setJobEdges((prev) =>
      prev[key] ? prev : { ...prev, [key]: EDGES[tapRef.current++ % EDGES.length] },
    );
    void kickoffJobContext(next);
    convo.setDraft(assembleJobMessage(next));
  }

  function _sendJobs() {
    if (jobs.length === 0) return;
    convo.commit(jobTurn(jobs[0]));
  }

  function _toggleRather(key: RatherKey) {
    const has = rathers.includes(key);
    const next = has ? rathers.filter((k) => k !== key) : [...rathers, key];
    setRathers(next);
    void kickoffRatherContext(next);
    convo.setDraft(assembleRatherMessage(next));
    if (has) return;
    const choice = RATHERS.find((r) => r.key === key)!;
    const nonce = (tapRef.current += 1);
    setMime({ rather: choice, edge: EDGES[nonce % EDGES.length], nonce });
    clearTimeout(mimeTimer.current);
    mimeTimer.current = window.setTimeout(() => setMime(null), 1500);
  }

  function _sendRathers() {
    if (rathers.length === 0) return;
    const choice = RATHERS.find((r) => r.key === rathers[0])!;
    convo.commit(ratherTurn(rathers[0], choice.label));
    setRatherSent(true);
  }

  function _acceptOffer() {
    clearBeatTimers();
    setMime(null);
    setPhase("style");
  }

  function onStyleRound(next: StyleProfile) {
    setStyle(next);
  }
  function onStyleDone(next: StyleProfile) {
    setStyle(next);
    setPhase("done");
  }

  const isShellPhase = phase === "preamble" || phase === "starter" || phase === "dialogue";

  return (
    <div className="cast-panel" ref={panelRef}>
      {phase === "login" && <LoginScreen onContinue={(fn) => { setUserFirstName(fn); setPhase("preamble"); }} />}

      {isShellPhase && (
        <SetupShell>
          {phase === "preamble" && (
            <PreambleScreen firstName={userFirstName} onContinue={() => setPhase("starter")} />
          )}

          {phase === "starter" && (
            <CastStarter resume={resume} onChoose={chooseStarter} onCustomizing={setCustomizing} embedded />
          )}

          {phase === "dialogue" && selected && (
            <VNDialogueFlow
              character={selected}
              name={name}
              userName={userFirstName}
              brainFileContent={brainFileContent}
              memories={memories}
              embedded
              onTonePicked={(value) =>
                recordMemory(
                  "tone",
                  value === "fast"
                    ? "Communication style: concise and direct"
                    : "Communication style: thorough and detailed",
                )
              }
              onReachPicked={(connected, credits) => {
                if (credits > 0) setEarnedCredits((prev) => prev + credits);
                recordMemory(
                  "reach",
                  connected.length > 0
                    ? `Connected: ${connected.map((k) => {
                        if (k === "google-calendar") return "Google Calendar";
                        return REACH_TOOLS.find((t) => t.key === k)?.label ?? k;
                      }).join(", ")}`
                    : "Tools: skipped",
                );
              }}
              onComplete={() =>
                onComplete({ character: selected, name, jobs, rathers, style, credits: earnedCredits })
              }
              onBack={reopenCustomize}
            />
          )}
        </SetupShell>
      )}

      <AnimatePresence>
        {phase === "starter" && customizing && (
            <MemoryList
              key="memory-list"
              entries={memories}
              typingStep={typingStep}
              onTyped={onMemoryTyped}
              assistantName={name}
            />
          )}
      </AnimatePresence>

      {phase === "style" && selected && (
        <CastTwoPanel
          left={
            <CastStyle
              character={selected}
              name={name}
              heroBox={leftPanelBox}
              jobs={jobs}
              ascended={rathers.length === RATHERS.length}
              onChoose={(value) => convo.send(styleTurn(value))}
              onRoundPicked={onStyleRound}
              onDone={onStyleDone}
              onBack={() => setPhase("dialogue")}
            />
          }
          right={<CastConversationView messages={convo.messages} assistantName={name} />}
        />
      )}

      {phase === "done" && selected && (
        <CastTwoPanel
          left={
            <CastProof
              character={selected}
              box={{ ...leftPanelBox, top: leftPanelBox.top + Math.round(leftPanelBox.size * 0.7) }}
              jobs={jobs}
              rathers={rathers}
              style={style}
              ascended={rathers.length === RATHERS.length}
              assistantId={assistantId}
              onAction={(which) => {
                console.log("[InteractiveSetup] proof action", { which });
              }}
              onEndpoint={() => {
                onComplete({ character: selected, name, jobs, rathers, style, credits: earnedCredits });
              }}
              onBack={() => setPhase("style")}
            />
          }
          right={<CastConversationView messages={convo.messages} assistantName={name} />}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// InteractiveSetup — top-level orchestrator
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function CastThemeToggle({ theme, onToggle }: { theme: "dark" | "light"; onToggle: () => void }) {
  return (
    <button
      className="cast-theme-toggle"
      onClick={onToggle}
      aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
    >
      {theme === "dark" ? (
        <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
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
        <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
        </svg>
      )}
    </button>
  );
}

export function InteractiveSetup() {
  const navigate = useNavigate();

  function handleComplete(_data: CastCompletionData) {
    navigate(routes.home);
  }

  return (
    <div className="cast-stage" data-theme="dark">
      <InteractiveCastFlow onComplete={handleComplete} />
    </div>
  );
}
