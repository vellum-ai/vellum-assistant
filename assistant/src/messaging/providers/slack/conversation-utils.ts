/**
 * Pure helpers for interpreting raw `SlackConversation` / `SlackUser`
 * payloads. Shared by the messaging adapter and the runtime Slack routes so
 * the flag semantics (`is_im`/`is_mpim`/`is_group`, `is_member`,
 * `is_private`) are derived in exactly one place.
 */

import type { SlackConversation, SlackUser } from "./types.js";

export type SlackConversationType = "channel" | "group" | "dm";

export function classifyConversationType(
  conv: SlackConversation,
): SlackConversationType {
  if (conv.is_im) {
    return "dm";
  }
  if (conv.is_mpim) {
    return "group";
  }
  if (conv.is_group) {
    return "group";
  }
  return "channel";
}

export function isPrivateConversation(
  conv: Partial<SlackConversation>,
): boolean {
  return conv.is_private ?? conv.is_group ?? false;
}

/**
 * Whether the connected identity can access this conversation. Slack omits
 * `is_member` on IM/MPIM rows; `conversations.list` only returns IMs/MPIMs
 * the authenticated identity can post to, so those count as member
 * conversations. Note this is access, not presence: Slack materializes IM
 * rows without any conversation happening (Slackbot, a user opening the
 * bot's DM tab) — surfaces that mean "an actual DM exists" must add their
 * own history check (see the slack channels route's memberOnly path).
 */
export function isMemberConversation(conv: SlackConversation): boolean {
  return conv.is_member === true || !!conv.is_im || !!conv.is_mpim;
}

/**
 * Best human-readable name for a Slack user, preferring the profile
 * display name. May return an empty string when every field is blank —
 * callers append their own last-resort fallback (e.g. the user ID).
 */
export function slackUserDisplayName(user: SlackUser): string {
  return (
    user.profile?.display_name ||
    user.profile?.real_name ||
    user.real_name ||
    user.name
  );
}

/**
 * Whether a Slack chat id names a 1:1 DM rather than a channel or group.
 *
 * Read off the id's prefix: `D` for a DM, `C` for a public or private channel,
 * `G` for a legacy group. Callers need this because a guardian binding can be
 * created from an `app_mention` in a shared channel, so a bound chat id is not
 * private by construction.
 *
 * An approximation, and the weaker of the two answers this module holds.
 * {@link classifyConversationType} reads Slack's own `is_im`/`is_mpim`/
 * `is_group` flags and is authoritative; prefer it wherever a
 * `SlackConversation` is in hand. This exists for the paths that hold only an
 * id and would otherwise spend a `conversations.info` round trip per message
 * to learn the same thing.
 */
export function isSlackDmChatId(chatId: string): boolean {
  return chatId.startsWith("D");
}
