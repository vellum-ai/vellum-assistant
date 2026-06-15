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
 *
 * Chrome (header, dialogue text, tone/reach choice cards, advance affordance) is
 * built from `@vellumai/design-library` primitives + design tokens + Tailwind.
 * `dialogue.css` carries only the bespoke VN choreography (typewriter cursor,
 * glass choice-card art, handoff loading dots/scene transitions).
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Button } from "@vellumai/design-library";

import { BlinkingAvatar } from "@/domains/onboarding/cast/cast-shell";
import type { CastCharacter } from "@/domains/onboarding/cast/cast-roster";
import type { CastTool } from "@/domains/onboarding/cast/cast-tools";
import { CAST_TOOLS, SECOND_REACH_TOOLS } from "@/domains/onboarding/cast/cast-tools";
import type { DialogueScreenProps } from "@/domains/onboarding/cast/screens/screen-slot";
import { publicAsset } from "@/utils/public-asset";
import "@/domains/onboarding/cast/cast.css";

// ---------------------------------------------------------------------------
// Reach tools — driven by the shared `cast-tools` registry. The second tool
// offered is chosen by analysing the brain-import context (or a deterministic
// per-character fallback); Google Calendar (the registry's first entry) is
// always offered first and is excluded from the second-slot candidates.
// ---------------------------------------------------------------------------

const GOOGLE_CALENDAR = CAST_TOOLS[0];

/** Render a tool's registry icon as the 32px reach-card image. */
function toolIcon(tool: CastTool): React.ReactNode {
  return <img src={publicAsset(tool.icon)} alt={tool.label} width={32} height={32} />;
}

/**
 * Analyse uploaded brain-import context to pick the best second OAuth tool.
 * Returns a tool from `SECOND_REACH_TOOLS`. Falls back to a deterministic
 * pick seeded from `characterId` when no context was uploaded or no keywords
 * match.
 */
function pickSecondReachTool(fileContent: string | null, characterId: string): CastTool {
  if (fileContent) {
    const lower = fileContent.toLowerCase();
    let best: CastTool | null = null;
    let bestScore = 0;
    for (const tool of SECOND_REACH_TOOLS) {
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
  return SECOND_REACH_TOOLS[Math.abs(hash) % SECOND_REACH_TOOLS.length];
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
  const reachTools = useMemo<CastTool[]>(
    () => [GOOGLE_CALENDAR, secondTool],
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
      {/* Back button (shared shell chrome) */}
      <button
        className="cast-back"
        onClick={(e) => { e.stopPropagation(); onBack(); }}
        aria-label="Back"
      >
        ‹
      </button>

      {/* Top-anchored dialogue area */}
      <div className="cast-vn__top">
        {/* Avatar + name header */}
        <div className="mb-5 flex items-center gap-3">
          <div className="size-20 flex-none">
            <BlinkingAvatar character={character} />
          </div>
          <span className="cast-dialogue__speaker">{name}</span>
        </div>

        {/* Dialogue text */}
        <p className="cast-dialogue__text">
          {text.slice(0, charCount)}
          {!typed && <span className="cast-vn__cursor">|</span>}
        </p>

        {/* Tone choices */}
        {step.kind === "tone" && typed && (
          <div className="grid grid-cols-2 gap-3.5">
            {(["left", "right"] as const).map((side) => {
              const label = side === "left" ? "Get to the point" : "Explain everything";
              const isPicked = tonePick === side;
              const isUnpicked = tonePick !== null && !isPicked;
              return (
                <motion.div
                  key={side}
                  className="flex"
                  animate={{ opacity: isUnpicked ? 0.4 : 1 }}
                  transition={{ duration: 0.3, ease: "easeOut" }}
                  whileHover={tonePick ? undefined : { y: -6 }}
                  whileTap={tonePick ? undefined : { scale: 0.97 }}
                >
                  <Button
                    variant="ghost"
                    fullWidth
                    className={`cast-dialogue__choice${isPicked ? " cast-dialogue__choice--selected" : ""}`}
                    onClick={(e) => { e.stopPropagation(); handleToneChoice(side); }}
                  >
                    {label}
                  </Button>
                </motion.div>
              );
            })}
          </div>
        )}

        {/* Reach tool cards */}
        {step.kind === "reach" && typed && (
          <>
            <div className="grid grid-cols-2 gap-3.5">
              {reachTools.map((tool) => {
                const isConnected = reachConnected.has(tool.slug);
                return (
                  <motion.div
                    key={tool.slug}
                    className="flex"
                    whileHover={isConnected ? undefined : { y: -6 }}
                    whileTap={isConnected ? undefined : { scale: 0.97 }}
                  >
                    <Button
                      variant="ghost"
                      fullWidth
                      className="cast-dialogue__choice relative flex-col gap-2.5"
                      style={{ opacity: isConnected ? 0.85 : 1, cursor: isConnected ? "default" : "pointer" }}
                      onClick={(e) => !isConnected && handleReachConnect(tool.slug, e)}
                    >
                      {toolIcon(tool)}
                      {tool.label}
                      {isConnected && (
                        <span className="cast-dialogue__connected-tag absolute right-2 top-2">
                          Connected
                        </span>
                      )}
                    </Button>
                  </motion.div>
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
              <motion.div
                key={loadingStepIdx}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.25 }}
              >
                <p className="cast-dialogue__loading-text">
                  {loadingSteps[loadingStepIdx]}
                </p>
              </motion.div>
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
