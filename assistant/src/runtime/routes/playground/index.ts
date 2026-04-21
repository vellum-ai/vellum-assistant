import type { RouteDefinition } from "../../http-router.js";
import type { PlaygroundRouteDeps } from "./deps.js";
import { forceCompactRouteDefinitions } from "./force-compact.js";
import { injectFailuresRouteDefinitions } from "./inject-failures.js";
import { resetCircuitRouteDefinitions } from "./reset-circuit.js";
import { stateRouteDefinitions } from "./state.js";

export type { PlaygroundRouteDeps };
export { assertPlaygroundEnabled } from "./guard.js";

export function playgroundRouteDefinitions(
  deps: PlaygroundRouteDeps,
): RouteDefinition[] {
  // Each playground route file exports its own `*RouteDefinitions(deps)`
  // factory; this aggregator spreads the arrays together. Later PRs in the
  // plan append more imports here — keeping it purely additive minimizes
  // conflicts across concurrent playground PRs.
  return [
    ...forceCompactRouteDefinitions(deps),
    ...injectFailuresRouteDefinitions(deps),
    ...resetCircuitRouteDefinitions(deps),
    ...stateRouteDefinitions(deps),
  ];
}
