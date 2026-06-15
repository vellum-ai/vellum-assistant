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
 * SCAFFOLDING (PR 5a): each phase renders a clearly-marked TEMPORARY inline stub
 * so the whole flow is navigable end-to-end. Sibling PRs 5b–5g drop the real
 * screens in against the contract. The completion path keeps the prototype's
 * existing `onComplete`/navigate stub — the `PreChatOnboardingContext` handoff +
 * background hatch land in a later PR (PR 6).
 */

import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { AnimatePresence } from "motion/react";

import { routes } from "@/utils/routes";
import type { JobKey, RatherKey } from "@/domains/onboarding/cast/cast-content";
import type { StyleProfile } from "@/domains/onboarding/cast/cast-templates";
import { CAST, type CastCharacter } from "@/domains/onboarding/cast/cast-roster";
import type { Rect } from "@/domains/onboarding/cast/cast-hero-types";
import { MemoryList, SetupShell } from "@/domains/onboarding/cast/cast-shell";
import type {
  BaseScreenProps,
  DialogueScreenProps,
  DoneScreenProps,
  LoginScreenProps,
  MemoryEntry,
  PreambleScreenProps,
  StarterResume,
  StarterScreenProps,
  StyleScreenProps,
} from "@/domains/onboarding/cast/screens/screen-slot";
import "@/domains/onboarding/cast/cast.css";

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

/**
 * Full prototype phase set, order preserved. The live phases the orchestrator
 * transitions through are `login → preamble → starter → dialogue → style →
 * done`. `vibe`, `brain`, `email`, `job`, and `rather` remain in the union for
 * fidelity but were collapsed into the `dialogue` Visual Novel scene and the
 * `style`/`done` panels at the prototype tip — the orchestrator neither sets nor
 * renders them. They are kept here so a sibling PR can re-introduce a phase
 * without reshaping the union.
 */
type CastPhase =
  | "login"
  | "preamble"
  | "starter"
  | "dialogue"
  | "vibe"
  | "brain"
  | "email"
  | "job"
  | "rather"
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
// TEMPORARY phase stubs (PR 5a).
//
// Each stub renders the phase name plus an Advance button wired to the
// screen-slot contract so the orchestrator compiles and the flow is navigable
// end-to-end. PRs 5b–5g replace each `StubScreen`-based component below with the
// real screen, keeping the same props.
// ---------------------------------------------------------------------------

function StubScreen({
  phase,
  onAdvance,
  onBack,
  advanceLabel = "Advance →",
  children,
}: BaseScreenProps & {
  phase: string;
  advanceLabel?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="cast-stub" data-phase={phase}>
      <span className="cast-stub__phase">{phase}</span>
      {children}
      <div className="cast-stub__actions">
        {onBack && (
          <button type="button" className="cast-stub__btn" onClick={onBack}>
            ‹ Back
          </button>
        )}
        <button type="button" className="cast-stub__btn cast-stub__btn--primary" onClick={onAdvance}>
          {advanceLabel}
        </button>
      </div>
    </div>
  );
}

function LoginScreenStub({ onContinue, onAdvance }: LoginScreenProps) {
  return (
    <StubScreen
      phase="login"
      advanceLabel="Continue →"
      onAdvance={() => {
        onContinue("Anita");
        onAdvance();
      }}
    >
      <span className="cast-stub__hint">Sign in + tell us your name</span>
    </StubScreen>
  );
}

function PreambleScreenStub({ firstName, onAdvance, onBack }: PreambleScreenProps) {
  return (
    <StubScreen phase="preamble" onAdvance={onAdvance} onBack={onBack}>
      <span className="cast-stub__hint">Nice to meet you, {firstName}</span>
    </StubScreen>
  );
}

function StarterScreenStub({ onChoose, onAdvance }: StarterScreenProps) {
  return (
    <StubScreen
      phase="starter"
      advanceLabel="Pick character →"
      onAdvance={() => {
        onChoose(PLACEHOLDER_CHARACTER, PLACEHOLDER_CHARACTER.name);
        onAdvance();
      }}
    >
      <span className="cast-stub__hint">Choose / customize your assistant</span>
    </StubScreen>
  );
}

function DialogueScreenStub({
  name,
  onTonePicked,
  onReachPicked,
  onComplete,
  onBack,
}: DialogueScreenProps) {
  return (
    <StubScreen
      phase="dialogue"
      advanceLabel="Run dialogue →"
      onBack={onBack}
      onAdvance={() => {
        onTonePicked("fast");
        onReachPicked([], 0);
        onComplete();
      }}
    >
      <span className="cast-stub__hint">Tone → reach → handoff for {name}</span>
    </StubScreen>
  );
}

function StyleScreenStub({ name, onRoundPicked, onDone, onBack }: StyleScreenProps) {
  return (
    <StubScreen
      phase="style"
      advanceLabel="Finish style →"
      onBack={onBack}
      onAdvance={() => {
        const next: StyleProfile = { autonomy: "send_it" };
        onRoundPicked(next);
        onDone(next);
      }}
    >
      <span className="cast-stub__hint">How should {name} work?</span>
    </StubScreen>
  );
}

function DoneScreenStub({ onEndpoint, onBack }: DoneScreenProps) {
  return (
    <StubScreen phase="done" advanceLabel="Let's go →" onBack={onBack} onAdvance={onEndpoint}>
      <span className="cast-stub__hint">Proof + endpoint into the assistant</span>
    </StubScreen>
  );
}

/**
 * Placeholder character for the starter stub so downstream phases have a real
 * `CastCharacter` to render. The first generated roster entry is deterministic.
 */
const PLACEHOLDER_CHARACTER: CastCharacter = CAST[0];

// ---------------------------------------------------------------------------
// InteractiveCastFlow — orchestrator. Owns the phase machine and selections;
// renders one screen per phase through the screen-slot contract.
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

  // Selections collected across the (currently stubbed) job/rather/style phases.
  // The setters beyond the resets below are wired up by sibling PRs 5b–5g; the
  // values flow into the screen-slot props and the completion payload.
  const [jobs, setJobs] = useState<JobKey[]>([]);
  const [rathers, setRathers] = useState<RatherKey[]>([]);
  const [style, setStyle] = useState<StyleProfile>({});

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

  function chooseStarter(char: CastCharacter, chosenName: string) {
    setSelected(char);
    setNames((prev) => ({ ...prev, [char.id]: chosenName }));
    addMemory("face", `Look & feel: ${chosenName}`, "dialogue");
    setPhase("dialogue");
  }

  function reopenCustomize() {
    setJobs([]);
    setRathers([]);
    setStyle({});
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
    setPhase("done");
  }

  const isShellPhase = phase === "preamble" || phase === "starter" || phase === "dialogue";

  return (
    <div className="cast-panel" ref={panelRef}>
      {phase === "login" && (
        <LoginScreenStub
          onAdvance={() => setPhase("preamble")}
          onContinue={(fn) => setUserFirstName(fn)}
        />
      )}

      {isShellPhase && (
        <SetupShell>
          {phase === "preamble" && (
            <PreambleScreenStub firstName={userFirstName} onAdvance={() => setPhase("starter")} />
          )}

          {phase === "starter" && (
            <StarterScreenStub
              resume={resume}
              onChoose={chooseStarter}
              onCustomizing={setCustomizing}
              onAdvance={() => {
                /* chooseStarter sets the next phase */
              }}
            />
          )}

          {phase === "dialogue" && selected && (
            <DialogueScreenStub
              character={selected}
              name={name}
              userName={userFirstName}
              brainFileContent={brainFileContent}
              memories={memories}
              onAdvance={() =>
                onComplete({ character: selected, name, jobs, rathers, style, credits: earnedCredits })
              }
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
                  connected.length > 0 ? `Connected: ${connected.join(", ")}` : "Tools: skipped",
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
        <StyleScreenStub
          character={selected}
          name={name}
          heroBox={leftPanelBox}
          jobs={jobs}
          ascended={false}
          onAdvance={() => setPhase("done")}
          onChoose={() => {
            /* style demo turn — wired by PR 5f */
          }}
          onRoundPicked={onStyleRound}
          onDone={onStyleDone}
          onBack={() => setPhase("dialogue")}
        />
      )}

      {phase === "done" && selected && (
        <DoneScreenStub
          character={selected}
          box={{ ...leftPanelBox, top: leftPanelBox.top + Math.round(leftPanelBox.size * 0.7) }}
          jobs={jobs}
          rathers={rathers}
          style={style}
          ascended={false}
          assistantId={null}
          onAdvance={() =>
            onComplete({ character: selected, name, jobs, rathers, style, credits: earnedCredits })
          }
          onAction={() => {
            /* proof action — wired by PR 5g */
          }}
          onEndpoint={() =>
            onComplete({ character: selected, name, jobs, rathers, style, credits: earnedCredits })
          }
          onBack={() => setPhase("style")}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// CastOnboardingFlow — top-level orchestrator entry (was `InteractiveSetup`).
// Wraps the flow in the themed cast stage and routes completion. The completion
// handler stays a navigate-to-home stub until PR 6 swaps in the
// PreChatOnboardingContext handoff + background hatch.
// ---------------------------------------------------------------------------

export function CastOnboardingFlow() {
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
