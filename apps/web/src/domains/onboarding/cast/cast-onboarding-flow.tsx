/**
 * Cast onboarding flow — the replacement for the legacy `PreChatFlow` step
 * pages, served only to the `experiment-activation-flow-2026-06-03 =
 * personal-page` arm. Control / variant-a users continue to see `PreChatFlow`
 * (the arm switch lives in `onboarding/pages/prechat-route.tsx`).
 *
 * This file ports the prototype orchestrator (`InteractiveCastFlow`): it owns the
 * `CastPhase` state machine and every collected selection, and renders one step
 * screen per phase through the screen-slot contract in `screens/screen-slot.ts`.
 *
 * PR 5h wires the six real screens (login / preamble / starter / dialogue /
 * style / done) in against the contract, replacing the PR 5a stubs.
 *
 * PR 6 replaces the prototype's `navigate` stub with the real handoff: the
 * assistant is background-hatched on entry to the login/role step (maximizing
 * overlap with the time the user spends in the flow), and on completion the
 * flow awaits hatch readiness, builds a `PreChatOnboardingContext` from the
 * collected selections, stashes it for the chat surface, and navigates — the
 * same finish sequence as `pages/pre-chat-flow.tsx`. The chat surface
 * auto-sends the research directive (the context's `initialMessage`) and
 * attaches the context as the `onboarding` payload on that same first send.
 */

import { useEffect, useRef, useState } from "react";
import { AnimatePresence } from "motion/react";

import type { StyleProfile } from "@/domains/onboarding/cast/cast-templates";
import type { CastCharacter } from "@/domains/onboarding/cast/cast-roster";
import type { Rect } from "@/domains/onboarding/cast/cast-hero-types";
import { MemoryList, SetupShell } from "@/domains/onboarding/cast/cast-shell";
import { LoginScreen } from "@/domains/onboarding/cast/screens/login-screen";
import { PreambleScreen } from "@/domains/onboarding/cast/screens/preamble-screen";
import { StarterScreen } from "@/domains/onboarding/cast/screens/starter-screen";
import { DialogueScreen } from "@/domains/onboarding/cast/screens/dialogue-screen";
import { StyleScreen } from "@/domains/onboarding/cast/screens/style-screen";
import { DoneScreen } from "@/domains/onboarding/cast/screens/done-screen";
import type {
  MemoryEntry,
  StarterResume,
} from "@/domains/onboarding/cast/screens/screen-slot";
import {
  buildCastPreChatContext,
  type CastSelections,
} from "@/domains/onboarding/cast/cast-prechat-mapping";
import { deriveTaskSuggestions } from "@/domains/onboarding/cast/cast-task-derivation";
import { useBackgroundHatch } from "@/domains/onboarding/cast/use-background-hatch";
import {
  setPendingAssistantName,
  setPendingPreChatContext,
} from "@/domains/onboarding/prechat";
import { DEFAULT_GROUP_ID } from "@/domains/onboarding/prechat-names";
import {
  emitOnboardingFunnelStepCompleted,
  ONBOARDING_FUNNEL_STEPS,
  ONBOARDING_FUNNEL_VARIANTS,
} from "@/domains/onboarding/funnel-events";
import { lifecycleService } from "@/assistant/lifecycle-service";
import { setSelectedAssistant } from "@/assistant/selection";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { useAuthStore } from "@/stores/auth-store";
import { useNavigate, useSearchParams } from "react-router";
import { routes } from "@/utils/routes";
import "@/domains/onboarding/cast/cast.css";

/**
 * The surviving cast phases that emit a funnel step on advance. Each maps to a
 * `cast_*` entry in `ONBOARDING_FUNNEL_STEPS`. The funnel is emitted on the
 * *advance out of* each phase, mirroring `pre-chat-flow.tsx`'s
 * `advance(from)` → `emitWebFunnelStep(from.funnelStep)`.
 */
const CAST_FUNNEL_STEP_BY_PHASE = {
  login: ONBOARDING_FUNNEL_STEPS.castLogin,
  preamble: ONBOARDING_FUNNEL_STEPS.castPreamble,
  starter: ONBOARDING_FUNNEL_STEPS.castStarter,
  dialogue: ONBOARDING_FUNNEL_STEPS.castDialogue,
  style: ONBOARDING_FUNNEL_STEPS.castStyle,
  done: ONBOARDING_FUNNEL_STEPS.castDone,
} as const;

/** Phase keys that emit a funnel step (the surviving cast walk). */
type CastFunnelPhase = keyof typeof CAST_FUNNEL_STEP_BY_PHASE;

/** Callback that emits one cast funnel step for the given phase. */
type EmitCastFunnelStep = (phase: CastFunnelPhase) => void;

/**
 * Map the cast dialogue "tone" choice onto a personality tone group id
 * understood by {@link PreChatOnboardingContext} ("grounded" | "warm" |
 * "energetic" | "poetic", per `PERSONALITY_GROUPS` in
 * `onboarding/prechat-names.ts`). The cast flow only collects a binary
 * fast/deep axis, so this is a deliberate, lossy projection onto the two
 * groups whose descriptors line up with that axis:
 *   - `"fast"` (concise, direct) → `"energetic"` (descriptor "Fast and direct")
 *   - `"deep"` (thorough, detailed) → `"grounded"` (descriptor "Calm and precise")
 *   - `null` (skipped) → `DEFAULT_GROUP_ID` ("grounded")
 *
 * Finalized in PR 7: the fast→energetic / deep→grounded pairing matches the
 * group descriptors directly, and a skipped tone defaulting to "grounded"
 * (the same `DEFAULT_GROUP_ID` the control funnel falls back to) keeps the
 * cast arm consistent with the rest of onboarding. The remaining two groups
 * ("warm", "poetic") have no corresponding cast axis to project from.
 */
export function castToneToGroupId(tone: "fast" | "deep" | null): string {
  if (tone === "fast") return "energetic";
  if (tone === "deep") return "grounded";
  return DEFAULT_GROUP_ID;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CastCompletionData {
  /** The user identity collected on the login screen. `role` → occupation. */
  firstName: string;
  lastName: string;
  role: string;
  character: CastCharacter;
  name: string;
  /** Dialogue-phase selections: communication tone + connected reach tools. */
  tone: "fast" | "deep" | null;
  connectedTools: string[];
  style: StyleProfile;
  credits: number;
}

/**
 * The live phases the orchestrator transitions through, order preserved:
 * `login → preamble → starter → dialogue → style → done`. The prototype's
 * `vibe`/`brain`/`email`/`job`/`rather` phases were collapsed into the
 * `dialogue` Visual Novel scene and the `style`/`done` panels, so they are not
 * part of the live state machine.
 */
type CastPhase =
  | "login"
  | "preamble"
  | "starter"
  | "dialogue"
  | "style"
  | "done";

// ---------------------------------------------------------------------------
// Shared layout helpers (same as the prototype cast-page)
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
// InteractiveCastFlow — orchestrator. Owns the phase machine and selections;
// renders one screen per phase through the screen-slot contract.
// ---------------------------------------------------------------------------

function InteractiveCastFlow({
  onComplete,
  onLoginPhase,
  emitFunnelStep,
}: {
  onComplete: (data: CastCompletionData) => void;
  /** Fired once when the flow first enters the login/role phase. */
  onLoginPhase: () => void;
  /** Emit a cast funnel step on advance out of the given phase. */
  emitFunnelStep: EmitCastFunnelStep;
}) {
  const panelRef = useRef<HTMLDivElement>(null);

  const [phase, setPhase] = useState<CastPhase>("login");

  // Kick off the background hatch on entry to the login/role step — the first
  // phase where the user supplies their occupation, so the hatch overlaps the
  // rest of the flow. Ref-guarded so it fires at most once regardless of
  // re-renders/keystrokes while the login screen is mounted.
  const loginHatchFiredRef = useRef(false);
  useEffect(() => {
    if (phase !== "login" || loginHatchFiredRef.current) return;
    loginHatchFiredRef.current = true;
    onLoginPhase();
  }, [phase, onLoginPhase]);

  // De-dupe funnel emissions: a phase can advance from multiple call sites
  // (e.g. style → done via both `onAdvance` and `onDone`), so guard each phase
  // to fire its step at most once per flow walk.
  const emittedPhasesRef = useRef<Set<CastFunnelPhase>>(new Set());
  function emitPhaseOnce(phase: CastFunnelPhase): void {
    if (emittedPhasesRef.current.has(phase)) return;
    emittedPhasesRef.current.add(phase);
    emitFunnelStep(phase);
  }

  const [userFirstName, setUserFirstName] = useState("");
  const [userLastName, setUserLastName] = useState("");
  // `userRole` is the field the later handoff maps to `occupation`.
  const [userRole, setUserRole] = useState("");
  const [selected, setSelected] = useState<CastCharacter | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const [customizing, setCustomizing] = useState(false);
  const [brainFileContent, setBrainFileContent] = useState<string | null>(null);
  const [earnedCredits, setEarnedCredits] = useState(0);

  const [boxes, setBoxes] = useState(() => {
    const { w, h } = win();
    return { top: topBoxFor(w, h), w };
  });

  // Style profile collected across the This-or-That rounds; flows into the
  // screen-slot props and the completion payload.
  const [style, setStyle] = useState<StyleProfile>({});

  // Dialogue-phase selections the later handoff PR reads alongside `userRole`,
  // `selected`/`name`, and `style`: the picked tone and the connected reach tools.
  const [tone, setTone] = useState<"fast" | "deep" | null>(null);
  const [connectedTools, setConnectedTools] = useState<string[]>([]);

  // Memory list — accumulates across the tone/vibe/reach This/That phases.
  // Entries are [step, text] tuples keyed by step so re-picks overwrite.
  const [memories, setMemories] = useState<MemoryEntry[]>([]);
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

  useEffect(() => {
    const onResize = () => {
      const { w, h } = win();
      setBoxes({ top: topBoxFor(w, h), w });
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const name = selected ? (names[selected.id] ?? selected.name) : "";
  const leftPanelBox: Rect = { ...boxes.top, left: boxes.w / 4 - boxes.top.size / 2 };

  const resume: StarterResume | null = selected
    ? {
        bodyShape: selected.bodyShape,
        eyeStyle: selected.eyeStyle,
        color: selected.color,
        name,
      }
    : null;

  /** Build the completion payload for a chosen character from current state. */
  function completionData(character: CastCharacter): CastCompletionData {
    return {
      firstName: userFirstName,
      lastName: userLastName,
      role: userRole,
      character,
      name,
      tone,
      connectedTools,
      style,
      credits: earnedCredits,
    };
  }

  /**
   * Finish the flow: emit the terminal `done` funnel step, then hand the
   * collected selections off to the parent. Wraps every handoff call site so
   * the `done` step fires exactly once regardless of which screen completes.
   */
  function completeHandoff(data: CastCompletionData) {
    emitPhaseOnce("done");
    onComplete(data);
  }

  function chooseStarter(char: CastCharacter, chosenName: string) {
    setSelected(char);
    setNames((prev) => ({ ...prev, [char.id]: chosenName }));
    addMemory("face", `Look & feel: ${chosenName}`, "dialogue");
    emitPhaseOnce("starter");
    setPhase("dialogue");
  }

  function reopenCustomize() {
    setStyle({});
    setTone(null);
    setConnectedTools([]);
    setMemories([]);
    setTypingStep(null);
    setBrainFileContent(null);
    setEarnedCredits(0);
    pendingPhaseRef.current = null;
    setPhase("starter");
  }

  function onStyleRound(next: StyleProfile) {
    setStyle(next);
  }
  function onStyleDone(next: StyleProfile) {
    setStyle(next);
    emitPhaseOnce("style");
    setPhase("done");
  }

  const isShellPhase = phase === "preamble" || phase === "starter" || phase === "dialogue";

  return (
    <div className="cast-panel" ref={panelRef}>
      {phase === "login" && (
        <LoginScreen
          onAdvance={() => {
            emitPhaseOnce("login");
            setPhase("preamble");
          }}
          onContinue={(fn) => setUserFirstName(fn)}
          onIdentity={({ lastName, role }) => {
            setUserLastName(lastName);
            setUserRole(role);
          }}
        />
      )}

      {isShellPhase && (
        <SetupShell>
          {phase === "preamble" && (
            <PreambleScreen
              firstName={userFirstName}
              onAdvance={() => {
                emitPhaseOnce("preamble");
                setPhase("starter");
              }}
            />
          )}

          {phase === "starter" && (
            <StarterScreen
              resume={resume}
              onChoose={chooseStarter}
              onCustomizing={setCustomizing}
              onAdvance={() => {
                /* chooseStarter sets the next phase */
              }}
            />
          )}

          {phase === "dialogue" && selected && (
            <DialogueScreen
              character={selected}
              name={name}
              userName={userFirstName}
              brainFileContent={brainFileContent}
              memories={memories}
              onAdvance={() =>
                completeHandoff(completionData(selected))
              }
              onTonePicked={(value) => {
                setTone(value);
                recordMemory(
                  "tone",
                  value === "fast"
                    ? "Communication style: concise and direct"
                    : "Communication style: thorough and detailed",
                );
              }}
              onReachPicked={(connected, credits) => {
                setConnectedTools(connected);
                if (credits > 0) setEarnedCredits((prev) => prev + credits);
                recordMemory(
                  "reach",
                  connected.length > 0 ? `Connected: ${connected.join(", ")}` : "Tools: skipped",
                );
              }}
              onComplete={() => {
                emitPhaseOnce("dialogue");
                setPhase("style");
              }}
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
        <StyleScreen
          character={selected}
          name={name}
          heroBox={leftPanelBox}
          onAdvance={() => {
            emitPhaseOnce("style");
            setPhase("done");
          }}
          onChoose={() => {
            /* style demo turn — no orchestrator state to capture here */
          }}
          onRoundPicked={onStyleRound}
          onDone={onStyleDone}
          onBack={() => setPhase("dialogue")}
        />
      )}

      {phase === "done" && selected && (
        <DoneScreen
          character={selected}
          box={{ ...leftPanelBox, top: leftPanelBox.top + Math.round(leftPanelBox.size * 0.7) }}
          style={style}
          ascended={false}
          assistantId={null}
          onAdvance={() =>
            completeHandoff(completionData(selected))
          }
          onAction={() => {
            /* proof action — no orchestrator state to capture here */
          }}
          onEndpoint={() =>
            completeHandoff(completionData(selected))
          }
          onBack={() => setPhase("style")}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// CastOnboardingFlow — top-level orchestrator entry (was `InteractiveSetup`).
// Wraps the flow in the themed cast stage and owns the completion handoff:
// background-hatch on login-step entry, then on completion await readiness,
// build the PreChatOnboardingContext, stash it, and finish like
// `pages/pre-chat-flow.tsx`. The chat surface auto-sends the research directive
// (the context's `initialMessage`) with the context attached as the
// `onboarding` payload — no extra send wiring here.
// ---------------------------------------------------------------------------

/** Build the handoff context from the flow's collected completion data. */
export function buildHandoffFromCompletion(
  data: CastCompletionData,
): { context: ReturnType<typeof buildCastPreChatContext>; assistantName: string } {
  const selections: CastSelections = {
    firstName: data.firstName || undefined,
    lastName: data.lastName || undefined,
    role: data.role || undefined,
    tone: castToneToGroupId(data.tone),
    reachTools: data.connectedTools,
    // The dedicated `job` phase is gone, so tasks come from the designated
    // source — `deriveTaskSuggestions`, fed by the connected-tools memory.
    jobs: deriveTaskSuggestions(
      data.connectedTools.length > 0
        ? [["reach", `Connected: ${data.connectedTools.join(", ")}`]]
        : [],
    ),
    // `priorAssistant` is not collected by the cast flow yet.
    priorAssistant: undefined,
    // The chosen cast name rides the context (not just the optimistic
    // pending-name key) so the onboarding payload carries `assistantName` and
    // the daemon persists it to IDENTITY.md after the first message.
    assistantName: data.name || undefined,
  };
  return {
    context: buildCastPreChatContext(selections),
    assistantName: data.name,
  };
}

/**
 * Inner flow body that owns one background-hatch instance. `useBackgroundHatch`
 * is ref-guarded with no reset, so a terminal failure is recovered by
 * remounting this component (the parent bumps `attempt`), which provisions a
 * fresh hatch. The completion data is lifted to the parent so it survives the
 * remount and the retry can replay the handoff without re-walking the flow.
 */
function CastFlowBody({
  completedData,
  onCompleted,
  onHandoffError,
  emitFunnelStep,
  isPreview,
}: {
  completedData: CastCompletionData | null;
  onCompleted: (data: CastCompletionData) => void;
  onHandoffError: (message: string) => void;
  emitFunnelStep: EmitCastFunnelStep;
  /**
   * Preview (`?preview=true`) renders the flow purely visually — no side
   * effects. The background hatch and the real handoff (hatch + select +
   * stash context + auto-send) are gated off, mirroring how
   * `pages/pre-chat-flow.tsx` skips its real completion in preview.
   */
  isPreview: boolean;
}) {
  const navigate = useNavigate();
  const { start, awaitReady } = useBackgroundHatch();
  const handoffStartedRef = useRef(false);

  async function runHandoff(data: CastCompletionData): Promise<void> {
    let assistantId: string;
    try {
      // Wait for the background hatch to report healthy before handing off.
      assistantId = await awaitReady();
    } catch (err) {
      onHandoffError(
        err instanceof Error
          ? err.message
          : "Failed to start your assistant. Please try again.",
      );
      return;
    }

    const { context, assistantName } = buildHandoffFromCompletion(data);
    setPendingPreChatContext(context);
    setPendingAssistantName(assistantName);

    // Mirror `pages/pre-chat-flow.tsx`'s finish: select the hatched assistant,
    // mark the chat surface as expecting the first message, refresh lifecycle,
    // then navigate to chat. The chat surface auto-sends `initialMessage`
    // (the research directive) with the context attached.
    //
    // In a multi-assistant session a *different* assistant may already be the
    // platform selection. Make the hatched assistant the selection (so the
    // persisted selection + lockfile converge on it) AND pin the lifecycle
    // refresh to the hatched id, so `checkAssistant` fetches/projects the
    // hatched assistant rather than re-fetching the prior selection and
    // overwriting `activeAssistantId` back to it — otherwise the onboarding
    // payload would be sent to the wrong assistant.
    useResolvedAssistantsStore.getState().setActiveAssistantId(assistantId);
    await setSelectedAssistant(assistantId);
    lifecycleService.markExpectingFirstMessage();
    await lifecycleService.checkAssistant(assistantId);
    // The chat surface's existing `initialMessage` auto-send path renders the
    // research directive (`CAST_RESEARCH_DIRECTIVE`) as the first user message
    // bubble — no separate send is wired here.
    void navigate(`${routes.assistant}?onboarding=1`, { replace: true });
  }

  // On a (re)mount that already has completion data — i.e. a retry — provision a
  // fresh hatch (the user is past the login step, so nothing else triggers it)
  // and replay the handoff. Ref-guarded so it fires once per mount. Inert in
  // preview (retry isn't reachable in preview since the handoff never runs).
  useEffect(() => {
    if (isPreview || !completedData || handoffStartedRef.current) return;
    handoffStartedRef.current = true;
    start();
    void runHandoff(completedData);
    // runHandoff/start are stable for the lifetime of this mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [completedData, isPreview]);

  function handleComplete(data: CastCompletionData) {
    // Preview is purely visual: let the flow advance but run no handoff (no
    // hatch readiness wait, no context stash, no select/auto-send, no nav).
    if (isPreview) return;
    if (handoffStartedRef.current) return;
    handoffStartedRef.current = true;
    onCompleted(data);
    void runHandoff(data);
  }

  return (
    <InteractiveCastFlow
      onComplete={handleComplete}
      // In preview the login phase must NOT kick off the background hatch.
      onLoginPhase={isPreview ? noop : start}
      emitFunnelStep={emitFunnelStep}
    />
  );
}

/** Stable no-op for inert preview wiring. */
function noop(): void {}

export function CastOnboardingFlow() {
  // Captured completion data survives a retry remount; bumping `attempt`
  // remounts `CastFlowBody` to provision a fresh hatch after a terminal failure.
  const [completedData, setCompletedData] = useState<CastCompletionData | null>(
    null,
  );
  const [handoffError, setHandoffError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  const [searchParams] = useSearchParams();
  const isPreview = searchParams.get("preview") === "true";
  const userId = useAuthStore.use.user()?.id ?? null;

  // Emit one cast funnel step per surviving phase. Gated exactly like
  // `pre-chat-flow.tsx`'s `emitWebFunnelStep`: skipped entirely in preview, and
  // (inside `emitOnboardingFunnelStepCompleted`) only sent when share-analytics
  // is enabled. The cast arm always reports the deterministic `cast` variant —
  // it is a distinct activation arm, not part of the pared-down/control A/B
  // split. We pass the variant explicitly rather than resolving from stored
  // state so a value cached under another experiment (e.g. `pared_down` from the
  // privacy screen) can never leak into cast funnel events.
  function emitFunnelStep(phase: CastFunnelPhase): void {
    if (isPreview) return;
    emitOnboardingFunnelStepCompleted(CAST_FUNNEL_STEP_BY_PHASE[phase], {
      userId,
      variant: ONBOARDING_FUNNEL_VARIANTS.cast,
    });
  }

  function retryHandoff() {
    setHandoffError(null);
    setAttempt((n) => n + 1);
  }

  return (
    <div className="cast-stage" data-theme="dark">
      <CastFlowBody
        key={attempt}
        completedData={completedData}
        onCompleted={setCompletedData}
        onHandoffError={setHandoffError}
        emitFunnelStep={emitFunnelStep}
        isPreview={isPreview}
      />
      {handoffError !== null && (
        <div className="cast-handoff-error" role="alert">
          <p>{handoffError}</p>
          <button type="button" onClick={retryHandoff}>
            Try again
          </button>
        </div>
      )}
    </div>
  );
}
