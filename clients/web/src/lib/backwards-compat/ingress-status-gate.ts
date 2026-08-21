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
 */
import { useAssistantSupports } from "./utils";

export const MIN_VERSION = "0.11.6";

/** `true` when the connected assistant serves the ingress-status probe. */
export function useSupportsIngressStatus(): boolean {
  return useAssistantSupports(MIN_VERSION);
}
