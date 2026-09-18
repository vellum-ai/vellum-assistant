/**
 * Telemetry for the companion surface's one-time introduction.
 *
 * Rides the onboarding funnel event shape and ingest path (`funnel-events.ts`),
 * which stores `step_name` and `funnel_version` as open strings, so these need
 * no backend change. It is a funnel of its own rather than a stage of the
 * pre-chat one, but it shares that funnel's session id, so a run can be joined
 * to the onboarding the user came through to reach it.
 *
 * **Main decides when; this window reports.** The run happens on a floating
 * window with no signed-in user and no consent answer, and half its moments are
 * decided in the Electron main process, which has neither a telemetry path nor
 * a way to read consent. So main names each moment and pushes it here
 * (`runtime/companion-intro-telemetry.ts`), and the app's own window, which is
 * signed in and holds the answer, is what emits.
 *
 * **There is no arm.** The run ships to everyone. `ab_variant` carries the two
 * facts every row has to be read against instead: which introduction this was,
 * and whether the microphone was already granted. They belong on every event
 * rather than on some of them, `screen` is spoken for by the beat, and the
 * ingest leaves no other per-event dimension open. Nothing here is randomized
 * and nothing is being compared as an experiment.
 *
 * Events:
 * - `companion_intro_exposed`     a run was due and the surface reached the
 *                                 screen, on the first beat.
 * - `companion_intro_advanced`    the run moved, carrying the beat it moved to,
 *                                 so drop-off is per card rather than per run.
 * - `companion_intro_completed`   the run reached its end, by the last card
 *                                 being walked off or its offer taken.
 * - `companion_intro_dismissed`   the run was refused, carrying the beat it was
 *                                 refused on. Putting the surface away from the
 *                                 tray mid-run counts here too: it is an answer
 *                                 to the introduction, and main records it as
 *                                 one.
 * - `companion_intro_offer_taken` the run's offer of a conversation was taken
 *                                 up, carrying the beat it was taken on, which
 *                                 is what separates the rehearsal the Talk beat
 *                                 asks for from the real call the last beat
 *                                 starts.
 *
 * A step back reports `advanced` on the beat it lands on, so how far a user got
 * is a distinct count of funnel sessions per beat rather than a sum of rows.
 */
import { useEffect } from "react";

import type {
  CompanionIntroEvent,
  CompanionIntroReport,
} from "@vellumai/ipc-contract";

import {
  emitOnboardingFunnelStepCompleted,
  type OnboardingFunnelStepDescriptor,
} from "@/domains/onboarding/funnel-events";
import {
  subscribeToCompanionIntroReports,
  takeCompanionIntroReports,
} from "@/runtime/companion-intro-telemetry";

export const COMPANION_INTRO_FUNNEL_VERSION = "companion_intro_v1";

/**
 * Keyed by the moment main reports, so a moment added to the contract cannot
 * be left without a step here.
 */
export const COMPANION_INTRO_FUNNEL_STEPS = {
  exposed: { stepName: "companion_intro_exposed", stepIndex: 0 },
  advanced: { stepName: "companion_intro_advanced", stepIndex: 1 },
  completed: { stepName: "companion_intro_completed", stepIndex: 2 },
  dismissed: { stepName: "companion_intro_dismissed", stepIndex: 3 },
  offer_taken: { stepName: "companion_intro_offer_taken", stepIndex: 4 },
} as const satisfies Record<
  CompanionIntroEvent,
  OnboardingFunnelStepDescriptor
>;

/**
 * The two facts a row has to be read against, stamped as `ab_variant`.
 *
 * The introduction's version separates the eight-beat run from the four-beat
 * one it replaced, which shares this funnel and whose beats it mostly does not
 * share. The microphone grant is not an aside either: the Talk beat and the
 * last beat both read it and say different things, so an ungranted run is a
 * different run, and one that ends in a system prompt rather than a call is a
 * different ending.
 */
export function companionIntroCohort(report: CompanionIntroReport): string {
  const mic = report.micGranted ? "mic_granted" : "mic_ungranted";
  return `intro${report.introVersion}_${mic}`;
}

/** Report one moment of a run. */
export function emitCompanionIntroReport(report: CompanionIntroReport): void {
  emitOnboardingFunnelStepCompleted(
    COMPANION_INTRO_FUNNEL_STEPS[report.event],
    {
      funnelVersion: COMPANION_INTRO_FUNNEL_VERSION,
      variant: companionIntroCohort(report),
      // The beat rides `screen`, the same dimension-in-`screen` pattern the rest
      // of the onboarding funnel uses, so a drop-off is a card rather than a run.
      screen: report.beat,
      // A refusal is the one moment of a run that is not the run working.
      outcome: report.event === "dismissed" ? "skipped" : "completed",
      // Main's clock. A report made with no window listening is held until one
      // comes back, so the moment reported is not always the moment reported
      // in: an ending dated to the next launch would be unplaceable.
      occurredAt: report.at,
    },
  );
}

/**
 * Report every moment of a run for as long as this window is up.
 *
 * Mounted in the app's own window, which is the only window main pushes to.
 * Inert everywhere there is no companion.
 */
export function useCompanionIntroFunnel(): void {
  useEffect(() => {
    // Subscribed before the reports main is holding are asked for, so a moment
    // that happens in the gap between the two is pushed rather than missed.
    const unsubscribe = subscribeToCompanionIntroReports(
      emitCompanionIntroReport,
    );
    void takeCompanionIntroReports().then((held) => {
      // Reported even if this effect has been torn down since: taking them
      // emptied main's side, so anything dropped here is lost for good.
      for (const report of held) {
        emitCompanionIntroReport(report);
      }
    });
    return unsubscribe;
  }, []);
}
