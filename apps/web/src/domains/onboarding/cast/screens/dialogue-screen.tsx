/**
 * `dialogue` screen — the unified Visual Novel scene (tone -> reach -> handoff).
 *
 * `VNDialogueFlow` is ported from the prototype's inline scene; `DialogueScreen`
 * adapts it to the `DialogueScreenProps` slot contract (tone -> `onTonePicked`,
 * reach -> `onReachPicked`, post-handoff settle -> `onComplete`).
 *
 * The VN scene's only sibling logic is the reach-tool picker, inlined below — it
 * does NOT use `cast-conversation` (that's the style two-panel demo's). Slack and
 * GitHub use integration SVGs rather than the prototype's dedicated icon
 * components, which don't exist in this onboarding domain.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";

import { BlinkingAvatar } from "@/domains/onboarding/cast/cast-shell";
import type { CastCharacter } from "@/domains/onboarding/cast/cast-roster";
import type { DialogueScreenProps } from "@/domains/onboarding/cast/screens/screen-slot";
import { publicAsset } from "@/utils/public-asset";
import "@/domains/onboarding/cast/cast.css";

// ---------------------------------------------------------------------------
// Reach tools — minimal closure for the reach phase. The second tool offered is
// chosen by analysing the brain-import context (or a deterministic per-character
// fallback); Google Calendar is always the first.
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
    icon: <img src={publicAsset("/images/integrations/github.svg")} alt="GitHub" width={32} height={32} />,
    keywords: ["github", "code", "programming", "repo", "pull request", "commit", "developer", "engineering", "software"],
  },
  {
    key: "slack",
    label: "Slack",
    icon: <img src={publicAsset("/images/integrations/slack.svg")} alt="Slack" width={32} height={32} />,
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
      : "I’ll take my time and explain everything.";
  }
  if (step.kind === "reach") return "Where should I start working?";
  if (step.kind === "reach-react") {
    return step.connected > 0
      ? "Nice, we’re connected. This is going to be good."
      : "No worries, we can set those up later.";
  }
  if (step.kind === "handoff-ready") return "I put together a workspace for you. Go take a look.";
  return "I did some research while we were talking. One sec…";
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
}: VNDialogueFlowProps) {
  const [step, setStep] = useState<VNStep>({ kind: "tone" });
  const [charCount, setCharCount] = useState(0);
  const [typed, setTyped] = useState(false);
  const [tonePick, setTonePick] = useState<"left" | "right" | null>(null);
  const [reachConnected, setReachConnected] = useState<Set<string>>(new Set());
  const [loadingStepIdx, setLoadingStepIdx] = useState(0);
  const loadingSteps = useMemo(() => [
    `Learning about ${userName}…`,
    "Reading public profiles…",
    "Looking for hobbies…",
    "Checking work history…",
    "Analyzing communication style…",
    "Mapping daily routines…",
    "Finding relevant tools…",
    "Setting up integrations…",
    "Configuring preferences…",
    "Building shortcuts…",
    "Optimizing workflows…",
    "Preparing suggestions…",
    "Personalizing the workspace…",
    "Final touches…",
  ], [userName]);

  const onCompleteRef = useRef(onComplete);
  useEffect(() => { onCompleteRef.current = onComplete; });

  const text = vnDialogueText(step, name);

  // Reach tools (same logic as the prototype's ReachChoice)
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

  return (
    <div className="cast-vn cast-vn--top">
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
}

// ---------------------------------------------------------------------------
// DialogueScreen — slot adapter conforming to `DialogueScreenProps`.
// ---------------------------------------------------------------------------

export function DialogueScreen({
  onBack,
  character,
  name,
  userName,
  brainFileContent,
  memories,
  onTonePicked,
  onReachPicked,
  onComplete,
}: DialogueScreenProps) {
  return (
    <VNDialogueFlow
      character={character}
      name={name}
      userName={userName}
      brainFileContent={brainFileContent}
      memories={memories}
      onTonePicked={onTonePicked}
      onReachPicked={onReachPicked}
      onComplete={onComplete}
      onBack={onBack ?? (() => {})}
    />
  );
}
