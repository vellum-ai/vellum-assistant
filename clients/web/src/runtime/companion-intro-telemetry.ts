import type { CompanionIntroReport } from "@vellumai/ipc-contract";

import { isElectron } from "@/runtime/is-electron";

/**
 * The moments of the companion's one-time introduction, as main saw them.
 *
 * **Main decides what happened; this window is how it gets reported.** Main is
 * the only side that sees a whole run: it starts one before the surface's
 * window exists, it answers the tray's hide, and a session started by a double
 * tap on the voice key reaches neither renderer. What main does not have is a
 * telemetry path or the user's answer about analytics, both of which live here.
 * So main names the moment and this window decides what to do with it
 * (`companion-intro-funnel.ts`).
 *
 * Pushed to the app's own window and never to the surface's, which is the same
 * choice `companion-intro-stage.ts` makes and for one more reason: the
 * surface's route is registered outside the app's auth middleware, so it has no
 * signed-in user, its own funnel session, and a consent answer that was never
 * synced to it.
 *
 * Nothing arrives in the browser, on iOS, or in the Windows shell, none of
 * which have a surface to introduce.
 */
export function subscribeToCompanionIntroReports(
  callback: (report: CompanionIntroReport) => void,
): () => void {
  const companion = isElectron() ? window.vellum?.companion : undefined;
  // A shell that predates the channel never publishes one, and a shell without
  // a surface has no `companion` at all.
  if (companion?.onIntroReport === undefined) {
    return () => undefined;
  }
  return companion.onIntroReport(callback);
}

/**
 * The reports main held because there was no window listening for them.
 *
 * The moment this exists for is the run's own ending: a user who puts the
 * surface away from the tray can do it with the app's window closed, and a run
 * that ended with nobody to tell is exactly the row the funnel cannot infer
 * from the others. Main holds those and hands them over here.
 *
 * Taken rather than read, so the same moment is never reported twice. Called
 * once on mount, after subscribing, and it is also what tells main this window
 * is listening: until it arrives main holds everything rather than pushing into
 * a window whose bundle has parsed but whose effects have not run.
 *
 * What a held report cannot bring with it is the funnel session it happened
 * under, which lives in this window's `sessionStorage` and dies with the
 * window. So a run whose ending outlived the window that saw its earlier
 * moments reports that ending under the session of the window that collected
 * it. The moment itself is exact (`report.at` is main's clock), and the device
 * and the funnel version are on every row, so the ending is still attributable;
 * it is the join by `session_id` alone that does not hold for that one case.
 */
export async function takeCompanionIntroReports(): Promise<
  CompanionIntroReport[]
> {
  const companion = isElectron() ? window.vellum?.companion : undefined;
  if (companion?.takeIntroReports === undefined) {
    return [];
  }
  return await companion.takeIntroReports();
}
