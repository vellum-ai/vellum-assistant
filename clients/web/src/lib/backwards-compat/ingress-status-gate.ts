/**
 * Backwards-compat gate: `GET /v1/assistants/{id}/integrations/ingress/status`.
 *
 * Old behavior (< MIN_VERSION): the daemon has no ingress-status route, so
 * the probe request 404s. Below the floor the Pair-a-device card never issues
 * it and keeps the pre-probe experience: no tunnel status row, no re-check
 * button, and the card's first-run guidance as the only tunnel hint.
 *
 * New behavior (>= MIN_VERSION): the route exists, so the card probes the
 * recorded public URL and reports what is actually serving it.
 *
 * MIN_VERSION invariant: no build with a base version below 0.11.6 carries
 * the route. `assistant/package.json` is 0.11.4, and `release/v0.11.5` was
 * cut from a commit that predates the route, so the whole 0.11.5 line lacks
 * it as well; 0.11.6 is the first line that can ship it. `versionSupports`
 * compares base versions first, so any lower floor (a dev-timestamp floor on
 * an earlier base included) would admit routeless 0.11.4 and 0.11.5 builds
 * and 404 against them. Dev builds with a pre-0.11.6 base are excluded even
 * when they do carry the route; that is the deliberate conservative trade for
 * zero 404 noise.
 *
 * Assistant-scoped via `useAssistantScopedSupports` (see its JSDoc in
 * `./utils.ts` for the atomic version+owner snapshot and the conservative
 * unknown/mismatch semantics). The scoping closes a cross-assistant skew
 * window: on a switch, the active-assistant id flips to the incoming
 * assistant a render before the identity store re-hydrates, so an unscoped
 * read would check the outgoing assistant's version and could aim the probe
 * at an incoming daemon below the floor. An owner mismatch reports
 * unsupported until the matching identity lands.
 */
import { useAssistantScopedSupports } from "./utils";

export const MIN_VERSION = "0.11.6";

/**
 * Returns `true` when the assistant that owns the probe serves the
 * ingress-status route. `ownerAssistantId` is the assistant whose ingress
 * status is being queried. Conservative (`false`) until that assistant's own
 * version hydrates and on any owner mismatch, so the status query stays idle
 * and a daemon without the route is never asked for it.
 */
export function useSupportsIngressStatus(
  ownerAssistantId: string | null | undefined,
): boolean {
  return useAssistantScopedSupports(MIN_VERSION, ownerAssistantId);
}
