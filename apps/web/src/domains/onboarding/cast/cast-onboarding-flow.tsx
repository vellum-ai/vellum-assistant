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
 * style / done) in against the contract, replacing the PR 5a stubs. The
 * completion path stays the prototype's existing `navigate` stub — the
 * `PreChatOnboardingContext` handoff + background hatch land in a later PR.
 */

import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { AnimatePresence } from "motion/react";

import { routes } from "@/utils/routes";
import type { JobKey, RatherKey } from "@/domains/onboarding/cast/cast-content";
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
import "@/domains/onboarding/cast/cast.css";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CastCompletionData {
  /** The user identity collected on the login screen. `role` → occupation. */
  firstName: string;
  lastName: string;
  role: string;
  character: CastCharacter;
  name: string;
  /** Dialogue-phase selections: communication tone + connected reach tools. */
  tone: "fast" | "deep" | null;
  connectedTools: string[];
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
// InteractiveCastFlow — orchestrator. Owns the phase machine and selections;
// renders one screen per phase through the screen-slot contract.
// ---------------------------------------------------------------------------

function InteractiveCastFlow({ onComplete }: { onComplete: (data: CastCompletionData) => void }) {
  const panelRef = useRef<HTMLDivElement>(null);

  const [phase, setPhase] = useState<CastPhase>("login");
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

  // Selections collected across the (currently stubbed) job/rather/style phases.
  // The setters beyond the resets below are wired up by sibling PRs 5b–5g; the
  // values flow into the screen-slot props and the completion payload.
  const [jobs, setJobs] = useState<JobKey[]>([]);
  const [rathers, setRathers] = useState<RatherKey[]>([]);
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
      jobs,
      rathers,
      style,
      credits: earnedCredits,
    };
  }

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
    setPhase("done");
  }

  const isShellPhase = phase === "preamble" || phase === "starter" || phase === "dialogue";

  return (
    <div className="cast-panel" ref={panelRef}>
      {phase === "login" && (
        <LoginScreen
          onAdvance={() => setPhase("preamble")}
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
            <PreambleScreen firstName={userFirstName} onAdvance={() => setPhase("starter")} />
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
                onComplete(completionData(selected))
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
              onComplete={() => setPhase("style")}
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
          jobs={jobs}
          ascended={false}
          onAdvance={() => setPhase("done")}
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
          jobs={jobs}
          rathers={rathers}
          style={style}
          ascended={false}
          assistantId={null}
          onAdvance={() =>
            onComplete(completionData(selected))
          }
          onAction={() => {
            /* proof action — no orchestrator state to capture here */
          }}
          onEndpoint={() =>
            onComplete(completionData(selected))
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
