/**
 * Backwards-compat gate: `GET /v1/debug/database`.
 *
 * Old behavior (< MIN_VERSION): the daemon has no database diagnostics
 * route, so the Debug Database tab would 404 on mount. Below the floor
 * the panel stays on the unsupported empty state and does not fetch.
 *
 * New behavior (>= MIN_VERSION): the route exists (and is exempt from
 * the DB migration readiness gate) so the tab can load even when
 * `/readyz` is red.
 *
 * MIN_VERSION is the current package version. Released 0.11.10 builds
 * that predate this route still match the floor, so the panel also
 * treats HTTP 404 as "unsupported" rather than a hard error.
 *
 * `versionSupports` treats `0.11.10-dev` / `0.11.10-local` as ahead of
 * the stable 0.11.10 floor, so local and CI builds light the tab up.
 */
import { useAssistantSupports } from "./utils";

export const MIN_VERSION = "0.11.10";

export function useSupportsDebugDatabase(): boolean {
  return useAssistantSupports(MIN_VERSION);
}
