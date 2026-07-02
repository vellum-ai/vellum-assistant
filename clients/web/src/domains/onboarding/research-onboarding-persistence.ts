/**
 * Refresh-resilient persistence for the research-onboarding flow.
 *
 * SPIKE — research-onboarding flow.
 *
 * The flow keeps its whole journey in React state, so a page refresh used to
 * remount at the form, re-fire the (expensive) "research me" background turn,
 * and risk re-booking the day-2 check-in. We snapshot the journey to
 * `localStorage` keyed by user (persists across reloads — and tab closes —
 * until onboarding completes and the snapshot is cleared) so a refresh resumes
 * where the user left off:
 *   - the collected details (form + avatar/name) are restored, so the early
 *     steps aren't re-asked;
 *   - the COMPLETED research output ({ claims, suggestions, installedPlugins })
 *     is restored, so the background search is NOT re-run and we land straight
 *     on the suggestions;
 *   - mid-flow (research not yet settled) resumes on the right step and re-
 *     attaches to the SAME research conversation via `researchConversationId`
 *     rather than minting a second one: the prior turn keeps generating server-
 *     side after the reload, so the route resumes polling it (and only re-posts
 *     the prompt if it never landed) instead of running a fresh search. The
 *     meeting is never re-booked because the booking step is never replayed.
 *
 * Best-effort: `localStorage` can throw under privacy modes / quota, so every
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
  | "personality"
  | "integration"
  | "letschat"
  | "meeting"
  | "looking"
  | "results"
  | "suggestions"
  | "finishing";

/** Completed research output — only snapshotted once the turn settles "done". */
export interface PersistedResearchResults {
  status: Extract<ResearchStatus, "done">;
  claims: ResearchFact[];
  suggestions: ResearchSuggestion[];
  installedPlugins: string[];
  /**
   * Name → description for the installed plugins, so a refresh-resume can still
   * render each plugin card with its description. Optional for back-compat with
   * snapshots written before this field existed (defaulted to {} on read).
   */
  pluginCatalog?: Record<string, string>;
}

export interface ResearchOnboardingSnapshot {
  step: ResearchStep;
  formValues: ResearchOnboardingValues | null;
  faceValues: GiveMeAFaceValues | null;
  /** Formatted booked check-in time ("2:30 PM"), or null when not booked. */
  checkinTime: string | null;
  /**
   * True only once the day-2 check-in was confirmed booked by the daemon. Kept
   * separate from the transient "meeting" confirmation step so a refresh that
   * interrupts the in-flight (non-idempotent) booking POST doesn't resume PAST
   * it as if it succeeded — see resolveResumeStep.
   */
  checkinBooked: boolean;
  /** Completed research output; null until the turn settles with results. */
  research: PersistedResearchResults | null;
  /**
   * Id of the behind-the-scenes "research me" conversation, saved as soon as it
   * is minted so a refresh mid-search can re-attach to (resume) that same thread
   * instead of starting a second search. Cleared implicitly with the snapshot
   * once onboarding completes. Absent on older snapshots / before the turn
   * starts.
   */
  researchConversationId?: string;
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
    const raw = localStorage.getItem(key);
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
    localStorage.setItem(key, JSON.stringify(snapshot));
  } catch {
    // localStorage can throw under privacy modes / quota — best-effort.
  }
}

export function clearResearchSnapshot(userId: string | null): void {
  const key = storageKey(userId);
  if (!key) return;
  try {
    localStorage.removeItem(key);
  } catch {
    // Best-effort.
  }
}

/**
 * Where a refresh should land given the saved journey. Once the research turn
 * finished, jump straight to the suggestions — the saved results render without
 * re-running the search.
 *
 * Otherwise resume the saved step, with one guard around the "meeting"
 * confirmation: that step is the booking's loading state, written the moment we
 * fire the (non-idempotent, best-effort) check-in POST. A refresh there can
 * cancel that request before the daemon books anything. So resume "meeting" to
 * the looking-you-up carousel ONLY when the booking was confirmed; otherwise
 * fall back to the calendar step so the user can complete it — restoring the
 * pre-resume behavior (a refresh used to restart the whole flow back through the
 * calendar) without ever auto-rebooking (that step books only on an explicit
 * click, so a booking that did succeed can't be silently duplicated).
 */
export function resolveResumeStep(
  snapshot: ResearchOnboardingSnapshot,
): ResearchStep {
  if (snapshot.research?.status === "done") return "suggestions";
  if (snapshot.step === "meeting") {
    return snapshot.checkinBooked ? "looking" : "letschat";
  }
  return snapshot.step;
}
