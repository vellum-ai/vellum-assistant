/**
 * Backwards-compat gate: the validated active-profile route.
 *
 * `PUT /v1/inference/active-profile` first ships in assistant 0.10.8
 * (PR #37748). The route validates the selection against the effective
 * profile catalog and — since the dispatch-availability guard — refuses a
 * profile that provably cannot serve requests, so routing the Settings
 * default-profile save through it surfaces a bad selection at the moment of
 * choice instead of on the next chat turn. Assistants older than 0.10.8
 * 404 the route, so the save falls back to the raw config PATCH those
 * assistants have always served.
 *
 * Scoped to the owning assistant via `useAssistantScopedSupports` — see its
 * JSDoc in `./utils.ts` for the atomic version+owner snapshot and
 * conservative unknown/mismatch semantics. Conservative (`false`) means the
 * fallback PATCH path, which every assistant serves.
 */
import { useAssistantScopedSupports } from "@/lib/backwards-compat/utils";

const MIN_VERSION = "0.10.8";

/**
 * Returns `true` when the assistant that owns the Settings surface serves
 * `PUT /v1/inference/active-profile`.
 */
export function useSupportsActiveProfileRoute(
  ownerAssistantId: string | null | undefined,
): boolean {
  return useAssistantScopedSupports(MIN_VERSION, ownerAssistantId);
}
