/**
 * Backwards-compat gate: effective inference-profile catalog.
 *
 * Old behavior (< MIN_VERSION): the daemon has no `GET /v1/inference/profiles`
 * route. The Language Model card derives its profile list from the raw
 * `config.llm.profiles` map: model/provider come from the stored entry and
 * no per-profile availability is known.
 *
 * New behavior (≥ MIN_VERSION): the route serves the *effective* catalog -
 * managed defaults merged with user profiles, each annotated with `source`
 * and connection `availability`, and with the model resolved the way the
 * daemon will actually dispatch it (e.g. managed tiers reflect the default
 * provider). The card prefers this list for display.
 *
 * Writes are NOT gated on this module: profile mutations keep flowing
 * through the universally-understood `PATCH /v1/config` deep-merge paths.
 *
 * MIN_VERSION names the next scheduled cut from main (0.11.0, cut
 * 2026-07-28), the first release carrying inference-profiles-routes.ts
 * with the availability annotations. A hotfix release branches from the
 * latest release tag instead, so a hotfix claiming this number would NOT
 * carry the route; if that happens, retarget to the next scheduled cut.
 */
import { useAssistantSupports } from "@/lib/backwards-compat/utils";

const MIN_VERSION = "0.11.0";

export function useSupportsInferenceProfiles(): boolean {
  return useAssistantSupports(MIN_VERSION);
}
