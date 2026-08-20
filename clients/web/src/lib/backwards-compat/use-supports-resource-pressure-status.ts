/**
 * Backwards-compat gate: `GET /v1/resource-pressure/status` polling.
 *
 * Old behavior (< MIN_VERSION): the daemon has no resource-pressure
 * routes, so the status poll 404s. The resource-pressure monitor is not
 * a React Query read (it is a hand-rolled setInterval poller), so the
 * app QueryClient's no-retry-on-4xx policy does not apply: ungated, a
 * new bundle against an older platform-hosted daemon fires the 404 on
 * mount, then again every poll tick and on every app resume, for the
 * whole session. Below the floor the monitor stays disabled, which is
 * exactly the feature-off state: no poll, no banner, and any
 * `resource_pressure_status_changed` SSE event can never arrive because
 * the daemon predates the guard that broadcasts it.
 *
 * New behavior (>= MIN_VERSION): the route exists and the monitor polls
 * it (still only for platform-hosted assistants; the call site ANDs
 * this gate with `useActiveAssistantIsPlatformHosted()`).
 *
 * MIN_VERSION invariant: no build with a base version below 0.11.5
 * carries the route (0.11.4 and earlier lines lack it entirely).
 * `versionSupports` compares base versions first, so any lower floor
 * (a dev-timestamp floor on an earlier base included) would admit
 * routeless 0.11.4 builds and 404-poll against them. Dev builds with a
 * pre-0.11.5 base are excluded even when they do carry the route; that
 * is the deliberate conservative trade for zero 404 noise.
 *
 * Unscoped on purpose: the monitor polls only the active assistant and
 * resets its snapshot on every assistant switch, so the worst a stale
 * cross-assistant version can cause is one unretried 404 in the
 * sub-second window before the incoming identity hydrates. There is no
 * query cache for a mis-scoped success to strand.
 */
import { useAssistantSupports } from "./utils";

export const MIN_VERSION = "0.11.5";

/**
 * Render-path gate for the resource-pressure status poll. `false` while
 * the version is unknown, which keeps the monitor off (feature-off
 * degrade) until identity resolves.
 */
export function useSupportsResourcePressureStatus(): boolean {
  return useAssistantSupports(MIN_VERSION);
}
