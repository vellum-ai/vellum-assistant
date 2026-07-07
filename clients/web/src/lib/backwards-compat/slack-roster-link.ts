/**
 * Backwards-compat gate: Slack "Link account" workspace-roster picker.
 *
 * The contact detail page's Slack row offers a "Link account" action backed
 * by the daemon's `GET /v1/slack/users` roster endpoint, which first ships
 * in the assistant version below. On an older assistant the endpoint 404s,
 * so the action (and the roster fetch behind the header provenance line's
 * @handle lookup) stays hidden and the row falls back to the Invite-only
 * treatment every assistant understands.
 *
 * Read-path gate: the fallback is purely presentational, so the
 * conservative `false`-on-unknown default is safe and no resolved-version
 * variant is needed.
 *
 * MIN_VERSION pins the first 0.10.6 dev build containing the roster route
 * (dev builds compare AHEAD of their stable base, so 0.10.6 stable stays
 * gated while post-merge 0.10.6-dev builds and the 0.10.7+ releases pass —
 * same technique as the vision attachment gate).
 */
import { useAssistantSupports } from "./utils";

export const MIN_VERSION = "0.10.6-dev.202607071900.0000000";

/**
 * Hook: `true` when the active assistant serves `GET /v1/slack/users`.
 * Subscribes to the identity store so the Slack row's actions re-render
 * when the version hydrates or crosses `MIN_VERSION`.
 */
export function useSupportsSlackRosterLink(): boolean {
  return useAssistantSupports(MIN_VERSION);
}
