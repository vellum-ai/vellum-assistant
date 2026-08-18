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
 * MIN_VERSION is the dev floor of the daemon-side commit that added the
 * route (d77d014, 2026-08-18T19:12Z UTC) rather than a predicted
 * release number: v0.11.3 was already tagged without the route, so
 * naming a release would either guess the next number or leave dev
 * builds dark. `versionSupports` compares base versions first, so every
 * later release satisfies this floor whatever it is numbered, and dev
 * builds cut from main after that timestamp read as supported.
 *
 * Unscoped on purpose: the monitor polls only the active assistant and
 * resets its snapshot on every assistant switch, so the worst a stale
 * cross-assistant version can cause is one unretried 404 in the
 * sub-second window before the incoming identity hydrates. There is no
 * query cache for a mis-scoped success to strand.
 */
import { useAssistantSupports } from "./utils";

export const MIN_VERSION = "0.11.3-dev.202608181912.d77d014";

/**
 * Render-path gate for the resource-pressure status poll. `false` while
 * the version is unknown, which keeps the monitor off (feature-off
 * degrade) until identity resolves.
 */
export function useSupportsResourcePressureStatus(): boolean {
  return useAssistantSupports(MIN_VERSION);
}
