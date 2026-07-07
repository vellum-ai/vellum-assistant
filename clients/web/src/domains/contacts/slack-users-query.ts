/**
 * Shared query options/key for the Slack workspace roster
 * (`GET /v1/slack/users`) behind the contact "Link account" picker.
 *
 * The roster is scoped to whichever Slack workspace the stored credentials
 * point at (same token resolution as `GET /v1/slack/channels`). A long
 * stale time keeps repeated picker opens from re-walking the paginated
 * Slack `users.list` API within a session.
 */
import {
  slackUsersGetOptions,
  slackUsersGetQueryKey,
} from "@/generated/daemon/@tanstack/react-query.gen";

const ROSTER_STALE_TIME_MS = 10 * 60 * 1000;

function rosterRequestOptions(assistantId: string) {
  return { path: { assistant_id: assistantId } };
}

export function slackRosterOptions(assistantId: string) {
  return {
    ...slackUsersGetOptions(rosterRequestOptions(assistantId)),
    staleTime: ROSTER_STALE_TIME_MS,
  };
}

export function slackRosterQueryKey(assistantId: string) {
  return slackUsersGetQueryKey(rosterRequestOptions(assistantId));
}
