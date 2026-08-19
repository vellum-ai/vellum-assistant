/**
 * Flag read for the managed Balanced profile's model A/B test.
 *
 * `experiment-balanced-model-2026-08-06` is a multivariate LaunchDarkly flag
 * whose arm repoints the model the managed (`vellum`) implementation of the
 * `balanced` default profile resolves to. The arm to model pins live beside
 * the profile bodies in `default-profile-catalog.ts`, which validates their
 * managed routability at load time; this module owns only the flag read.
 *
 * The read goes straight to the override cache rather than through
 * `assistant-feature-flags.ts`. `feature-flag-cache.ts` is a stdlib-only leaf,
 * so the profile catalog stays free of the pino logger and the gateway IPC
 * client that resolver would pull into its import graph, and the registry
 * declares `defaultEnabled: "control"` for this flag, which is the same
 * shipped body an absent override already resolves to. That equivalence is
 * pinned by `__tests__/balanced-model-experiment.test.ts` so it cannot drift.
 */

import { getCachedOverrides } from "./feature-flag-cache.js";

export const BALANCED_MODEL_EXPERIMENT_FLAG_KEY =
  "experiment-balanced-model-2026-08-06";

/**
 * The experiment arm in force, or `undefined` when the flag resolves to
 * anything that is not an arm name: unset, a boolean, or the empty string.
 * `control` and any arm this build does not know are returned as-is and miss
 * the pin table, which is what keeps a stale or malformed LaunchDarkly value
 * on the shipped model rather than stranding an install on one that does not
 * exist.
 */
export function getBalancedModelExperimentArm(): string | undefined {
  const value = getCachedOverrides()?.[BALANCED_MODEL_EXPERIMENT_FLAG_KEY];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
