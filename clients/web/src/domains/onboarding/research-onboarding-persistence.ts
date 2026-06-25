/**
 * Refresh-resilient persistence for the research-onboarding flow.
 *
 * SPIKE — research-onboarding flow.
 *
 * The flow keeps its whole journey in React state, so a page refresh used to
 * remount at the form, re-fire the (expensive) "research me" background turn,
 * and risk re-booking the day-2 check-in. We snapshot the journey to
 * `sessionStorage` (per-tab, cleared on tab close) keyed by user so a refresh
 * resumes where the user left off:
 *   - the collected details (form + avatar/name) are restored, so the early
 *     steps aren't re-asked;
 *   - the COMPLETED research output ({ claims, suggestions, installedPlugins })
 *     is restored, so the background search is NOT re-run and we land straight
 *     on the suggestions;
 *   - mid-flow (research not yet settled) resumes on the right step and lets the
 *     route re-fire the search once — the in-flight client turn can't survive a
 *     reload, so there's nothing to recover, but the meeting is never re-booked
 *     because the booking step is never replayed.
 *
 * Best-effort: `sessionStorage` can throw under privacy modes / quota, so every
 * access is guarded and a failure just degrades to the old restart-at-form
 * behavior.
 */

import type { ResearchStatus } from "@/domains/onboarding/research-runner";
import type { ResearchOnboardingValues } from "@/domains/onboarding/screens/research-onboarding-screen";
import type { GiveMeAFaceValues } from "@/domains/onboarding/screens/give-me-a-face-screen";
import type {
  ResearchFact,
  ResearchSuggestion,
} from "@/utils/research-facts";

/** The sub-steps the research-onboarding route sequences through. */
export type ResearchStep =
  | "form"
  | "face"
  | "intro"
  | "different"
  | "integration"
  | "letschat"
  | "meeting"
  | "looking"
  | "results"
  | "suggestions";

/** Completed research output — only snapshotted once the turn settles "done". */
export interface PersistedResearchResults {
  status: Extract<ResearchStatus, "done">;
  claims: ResearchFact[];
  suggestions: ResearchSuggestion[];
  installedPlugins: string[];
}

export interface ResearchOnboardingSnapshot {
  step: ResearchStep;
  formValues: ResearchOnboardingValues | null;
  faceValues: GiveMeAFaceValues | null;
  /** Formatted booked check-in time ("2:30 PM"), or null when not booked. */
  checkinTime: string | null;
  /** Completed research output; null until the turn settles with results. */
  research: PersistedResearchResults | null;
}

function storageKey(userId: string | null): string | null {
  return userId ? `research_onboarding:${userId}` : null;
}

export function readResearchSnapshot(
  userId: string | null,
): ResearchOnboardingSnapshot | null {
  const key = storageKey(userId);
  if (!key) return null;
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw) as ResearchOnboardingSnapshot;
  } catch {
    // Unreadable / malformed / privacy-mode throw — start fresh.
    return null;
  }
}

export function writeResearchSnapshot(
  userId: string | null,
  snapshot: ResearchOnboardingSnapshot,
): void {
  const key = storageKey(userId);
  if (!key) return;
  try {
    sessionStorage.setItem(key, JSON.stringify(snapshot));
  } catch {
    // sessionStorage can throw under privacy modes / quota — best-effort.
  }
}

export function clearResearchSnapshot(userId: string | null): void {
  const key = storageKey(userId);
  if (!key) return;
  try {
    sessionStorage.removeItem(key);
  } catch {
    // Best-effort.
  }
}

/**
 * Where a refresh should land given the saved journey. Once the research turn
 * finished, jump straight to the suggestions — the saved results render without
 * re-running the search. Otherwise resume the saved step, but never replay the
 * one-shot "Check-in scheduled!" confirmation: the booking already happened, so
 * resume on the looking-you-up carousel that follows it instead.
 */
export function resolveResumeStep(
  snapshot: ResearchOnboardingSnapshot,
): ResearchStep {
  if (snapshot.research?.status === "done") return "suggestions";
  if (snapshot.step === "meeting") return "looking";
  return snapshot.step;
}
