/**
 * Stamp the workspace id (`team_id`) from the events_api envelope onto the inner
 * Slack event when the event itself doesn't carry a `team`.
 *
 * Slack's inner events don't reliably include `team` (app_mention and channel
 * messages commonly omit it), so the payload-level `team_id` is the fallback
 * source for the actor's workspace. `teamId` comes from an **unvalidated**
 * `JSON.parse` of the socket frame, so a non-string value is ignored rather than
 * written as a garbage `actor.teamId`. An event-level `team` (e.g. a Slack
 * Connect sender's home workspace) takes precedence and is left untouched.
 */
export function stampSlackEventTeam(
  event: { team?: string },
  teamId: unknown,
): void {
  if (typeof teamId === "string" && teamId && !event.team) {
    event.team = teamId;
  }
}
