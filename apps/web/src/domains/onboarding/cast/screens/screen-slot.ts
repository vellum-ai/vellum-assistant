/**
 * Screen-slot contract for the cast onboarding flow.
 *
 * The orchestrator (`InteractiveCastFlow` in `cast-onboarding-flow.tsx`) owns the
 * phase state machine and all collected selections; each step phase is rendered
 * into a "slot" that receives a typed props object. PR 5a ships temporary inline
 * stubs against this contract; sibling PRs 5b–5g replace the stubs with the real
 * screens without touching the orchestrator.
 *
 * Every slot gets the common navigation pair (`onAdvance` / `onBack`); phases
 * that need shared per-step inputs (the selected character, its name, the user's
 * first name, the accumulated memory list, the collected style profile, hero
 * geometry) extend `BaseScreenProps` with their own slice. The
 * props the orchestrator already passes each phase in the prototype are the
 * source of truth for these shapes.
 */

import type { StyleProfile } from "@/domains/onboarding/cast/cast-templates";
import type { CastCharacter } from "@/domains/onboarding/cast/cast-roster";
import type { Rect } from "@/domains/onboarding/cast/cast-hero-types";

/** A `[step, text]` tuple in the persistent "making of" memory list. */
export type MemoryEntry = [step: string, text: string];

/**
 * Common props every step screen receives. `onAdvance` moves the flow forward
 * (the orchestrator decides the next phase); `onBack` steps it back. Screens
 * that collect a value call the phase-specific callbacks in their own props and
 * then `onAdvance`.
 */
export interface BaseScreenProps {
  /** Advance to the next phase in the orchestrator's order. */
  onAdvance: () => void;
  /** Step back to the previous phase (omitted on phases with no predecessor). */
  onBack?: () => void;
}

/**
 * The full identity payload the login screen collects (a superset of
 * `onContinue`'s first name). `role` is mapped to the downstream occupation in
 * the `PreChatOnboardingContext` handoff, so the orchestrator captures it now.
 */
export interface LoginIdentity {
  firstName: string;
  lastName: string;
  role: string;
}

/** `login` — collects the user's first name (+ last name / role) before any character exists. */
export interface LoginScreenProps extends BaseScreenProps {
  /** Receives the captured first name; the orchestrator then advances. */
  onContinue: (firstName: string) => void;
  /**
   * Receives the full identity payload (first/last name + role). The orchestrator
   * captures `role` for the occupation handoff. Optional so non-identity callers
   * (and tests) can wire only `onContinue`.
   */
  onIdentity?: (identity: LoginIdentity) => void;
}

/** `preamble` — story intro keyed off the user's first name. */
export interface PreambleScreenProps extends BaseScreenProps {
  firstName: string;
}

/**
 * `starter` — character selection / customization. `resume` pre-seeds the
 * picker with a previously chosen character (back-navigation), or is `null`.
 */
export interface StarterScreenProps extends BaseScreenProps {
  resume: StarterResume | null;
  /** Commit a chosen character + display name; the orchestrator advances. */
  onChoose: (character: CastCharacter, name: string) => void;
  /** Notify the orchestrator the user opened the customize panel. */
  onCustomizing: (customizing: boolean) => void;
}

/** The resumable character state handed back into the starter screen. */
export interface StarterResume {
  bodyShape: string;
  eyeStyle: string;
  color: string;
  name: string;
}

/**
 * `dialogue` — the unified Visual Novel scene (tone → reach → handoff). Records
 * tone + reach choices into the memory list, then completes the flow.
 */
export interface DialogueScreenProps extends BaseScreenProps {
  character: CastCharacter;
  name: string;
  userName: string;
  brainFileContent: string | null;
  memories: MemoryEntry[];
  onTonePicked: (value: "fast" | "deep") => void;
  onReachPicked: (connected: string[], creditsEarned: number) => void;
  onComplete: () => void;
}

/** `style` — the "how should I work" rounds, rendered in the two-panel demo. */
export interface StyleScreenProps extends BaseScreenProps {
  character: CastCharacter;
  name: string;
  heroBox: Rect;
  onChoose: (value: string) => void;
  onRoundPicked: (next: StyleProfile) => void;
  onDone: (next: StyleProfile) => void;
}

/** `done` — the proof / endpoint screen that finishes onboarding. */
export interface DoneScreenProps extends BaseScreenProps {
  character: CastCharacter;
  box: Rect;
  style: StyleProfile;
  ascended: boolean;
  assistantId: string | null;
  onAction: (which: string) => void;
  onEndpoint: () => void;
}
