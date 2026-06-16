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
import { useQuery } from "@tanstack/react-query";
import { Button } from "@vellumai/design-library";

import { BlinkingAvatar } from "@/domains/onboarding/cast/cast-shell";
import type { CastCharacter } from "@/domains/onboarding/cast/cast-roster";
import type { CastTool } from "@/domains/onboarding/cast/cast-tools";
import { CAST_TOOLS, pickSecondReachTool } from "@/domains/onboarding/cast/cast-tools";
import type { DialogueScreenProps } from "@/domains/onboarding/cast/screens/screen-slot";
import { useOAuthConnect } from "@/hooks/use-oauth-connect";
import { oauthProvidersGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";
import {
  assistantsOauthConnectionsListOptions,
  assistantsOauthConnectionsListQueryKey,
} from "@/generated/api/@tanstack/react-query.gen";
import type { OAuthConnection } from "@/generated/api/types.gen";
import { publicAsset } from "@/utils/public-asset";
import "@/domains/onboarding/cast/cast.css";

// ---------------------------------------------------------------------------
// Reach tools — driven by the shared `cast-tools` registry. Google Calendar
// (the registry's first entry) is always offered first; the second tool is
// chosen from the user's role/occupation, falling back to a deterministic
// per-character pick. The cards trigger real OAuth (see `ReachToolCard`).
// ---------------------------------------------------------------------------

const GOOGLE_CALENDAR = CAST_TOOLS[0];

/** Render a tool's registry icon as the 32px reach-card image. */
function toolIcon(tool: CastTool): React.ReactNode {
  return <img src={publicAsset(tool.icon)} alt={tool.label} width={32} height={32} />;
}

/** True when the assistant has a live connection for the tool's provider. */
function isToolConnected(
  connections: OAuthConnection[] | undefined,
  tool: CastTool,
): boolean {
  return Boolean(
    connections?.find((c) => c.provider === tool.provider)?.connected,
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
  occupation: string;
  assistantId: string | null;
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
  occupation,
  assistantId,
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

  // Reach tools: Google Calendar always first, the second chosen from the
  // user's role/occupation (e.g. engineer → GitHub, PM → Linear).
  const secondTool = useMemo(
    () => pickSecondReachTool(occupation, character.id),
    [occupation, character.id],
  );
  const reachTools = useMemo<CastTool[]>(
    () => [GOOGLE_CALENDAR, secondTool],
    [secondTool],
  );

  // OAuth state for the reach cards. The background-hatched assistant owns the
  // connections; the queries stay disabled (and the cards non-connectable)
  // until its id is available. `oauthProvidersGet` tells us which providers
  // support managed mode; `connections` reflects what's actually connected.
  const { data: providers } = useQuery({
    ...oauthProvidersGetOptions({
      path: { assistant_id: assistantId ?? "" },
    }),
    select: (data) => data.providers,
    enabled: !!assistantId,
  });
  const connectionsQueryKey = assistantsOauthConnectionsListQueryKey({
    path: { assistant_id: assistantId ?? "" },
  });
  const { data: connections } = useQuery({
    ...assistantsOauthConnectionsListOptions({
      path: { assistant_id: assistantId ?? "" },
    }),
    enabled: !!assistantId,
  });

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

  // --- Reach continue --- (each card connects via real OAuth in `ReachToolCard`;
  // the connected set is read back from the live connections query here).
  function handleReachContinue(e: React.MouseEvent) {
    e.stopPropagation();
    const connected = reachTools
      .filter((tool) => isToolConnected(connections, tool))
      .map((tool) => tool.slug);
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

        {/* Reach tool cards — each connects via real OAuth. */}
        {step.kind === "reach" && typed && (
          <>
            <div className="grid grid-cols-2 gap-3.5">
              {reachTools.map((tool) => (
                <ReachToolCard
                  key={tool.slug}
                  tool={tool}
                  assistantId={assistantId}
                  providers={providers}
                  connections={connections}
                  connectionsQueryKey={connectionsQueryKey}
                />
              ))}
            </div>
            <Button
              variant="primary"
              className="self-center"
              onClick={handleReachContinue}
            >
              Continue
            </Button>
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
// ReachToolCard — one reach-phase card wired to the real OAuth connect flow.
// Rendered as its own component so each card owns a single `useOAuthConnect`
// instance (the hook can't be called in a loop in the parent).
// ---------------------------------------------------------------------------

function ReachToolCard({
  tool,
  assistantId,
  providers,
  connections,
  connectionsQueryKey,
}: {
  tool: CastTool;
  assistantId: string | null;
  providers:
    | Array<{ provider_key: string; supports_managed_mode: boolean }>
    | undefined;
  connections: OAuthConnection[] | undefined;
  connectionsQueryKey: ReturnType<typeof assistantsOauthConnectionsListQueryKey>;
}) {
  const managedAvailable = Boolean(
    providers?.find((p) => p.provider_key === tool.provider)
      ?.supports_managed_mode,
  );
  const { handleConnect, oauthInProgress, startOAuthPending } = useOAuthConnect({
    assistantId: assistantId ?? "",
    providerKey: tool.provider,
    displayName: tool.label,
    managedAvailable,
    connectionsQueryKey,
    allConnections: connections,
  });

  const isConnected = isToolConnected(connections, tool);
  const busy = oauthInProgress || startOAuthPending;
  // The hatch may still be in flight, or the provider may not support managed
  // mode — in either case the card can't connect yet.
  const unavailable = !assistantId || !managedAvailable;
  const interactive = !isConnected && !busy && !unavailable;

  return (
    <motion.div
      className="flex"
      whileHover={interactive ? { y: -6 } : undefined}
      whileTap={interactive ? { scale: 0.97 } : undefined}
    >
      <Button
        variant="ghost"
        fullWidth
        disabled={unavailable}
        className="cast-dialogue__choice relative flex-col gap-2.5"
        style={{
          opacity: isConnected ? 0.85 : 1,
          cursor: interactive ? "pointer" : "default",
        }}
        onClick={(e) => {
          e.stopPropagation();
          if (interactive) handleConnect();
        }}
      >
        {toolIcon(tool)}
        {tool.label}
        {isConnected ? (
          <span className="cast-dialogue__connected-tag absolute right-2 top-2">
            Connected
          </span>
        ) : busy ? (
          <span className="cast-dialogue__connected-tag absolute right-2 top-2">
            Connecting…
          </span>
        ) : null}
      </Button>
    </motion.div>
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
  occupation,
  assistantId,
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
      occupation={occupation}
      assistantId={assistantId}
      memories={memories}
      onTonePicked={onTonePicked}
      onReachPicked={onReachPicked}
      onComplete={onComplete}
      onBack={onBack ?? (() => {})}
    />
  );
}
