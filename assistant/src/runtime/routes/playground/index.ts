import type { RouteDefinition } from "../../http-router.js";
import type { PlaygroundRouteDeps } from "./deps.js";
import { forceCompactRouteDefinitions } from "./force-compact.js";
import { resetCircuitRouteDefinitions } from "./reset-circuit.js";
import { stateRouteDefinitions } from "./state.js";

export type { PlaygroundRouteDeps };
export { assertPlaygroundEnabled } from "./guard.js";

export function playgroundRouteDefinitions(
  deps: PlaygroundRouteDeps,
): RouteDefinition[] {
  // Subsequent PRs append concrete route builders here (each returns
  // RouteDefinition[]). Keeping this as a spread list makes later PRs
  // purely additive with minimal conflict risk across concurrent PRs.
  return [
    ...forceCompactRouteDefinitions(deps),
    ...resetCircuitRouteDefinitions(deps),
    ...stateRouteDefinitions(deps),
  ];
}
