import {
  FN_CLAIMANT_BUNDLE_IDS,
  FN_CLAIMANTS,
  type FnClaimant,
} from "@vellumai/ipc-contract";

import { runningApps } from "@/runtime/running-apps";

export { FN_CLAIMANTS, type FnClaimant };

/**
 * The first claimant running right now that the app offers to quit, if any:
 * the dictation app whose paste a hold's words are offered against.
 */
export async function findRunningFnClaimant(): Promise<FnClaimant | null> {
  const quittable = FN_CLAIMANTS.filter((app) => app.quittable);
  const running = await runningApps(quittable.map((app) => app.bundleId));
  return quittable.find((app) => running.includes(app.bundleId)) ?? null;
}

/**
 * The names of every known claimant running right now, for a note that says
 * where a press that never reached Vellum may have gone. One name per app,
 * even where the app runs as more than one process.
 */
export async function runningFnClaimantNames(): Promise<string[]> {
  const running = await runningApps(FN_CLAIMANT_BUNDLE_IDS);
  const names = FN_CLAIMANTS.filter((app) =>
    running.includes(app.bundleId),
  ).map((app) => app.name);
  return Array.from(new Set(names));
}
