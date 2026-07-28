import type { SlackUserInfo } from "./user-directory.js";
import type {
  NormalizedSlackEvent,
  SlackBotProfile,
  SlackBotSenderInfo,
} from "./message-schemas.js";

export type SlackUserActorFields = Pick<
  SlackUserInfo,
  | "displayName"
  | "username"
  | "timezone"
  | "timezoneLabel"
  | "timezoneOffsetSeconds"
  | "isBot"
  | "isStranger"
  | "isRestricted"
>;

export function slackUserActorFields(
  userInfo: SlackUserInfo,
): SlackUserActorFields {
  return {
    displayName: userInfo.displayName,
    username: userInfo.username,
    ...(userInfo.timezone !== undefined ? { timezone: userInfo.timezone } : {}),
    ...(userInfo.timezoneLabel !== undefined
      ? { timezoneLabel: userInfo.timezoneLabel }
      : {}),
    ...(userInfo.timezoneOffsetSeconds !== undefined
      ? { timezoneOffsetSeconds: userInfo.timezoneOffsetSeconds }
      : {}),
    ...(userInfo.isBot !== undefined ? { isBot: userInfo.isBot } : {}),
    ...(userInfo.isStranger !== undefined
      ? { isStranger: userInfo.isStranger }
      : {}),
    ...(userInfo.isRestricted !== undefined
      ? { isRestricted: userInfo.isRestricted }
      : {}),
  };
}

/**
 * Classify a Slack message sender as a bot/app.
 *
 * Slack marks bot-authored messages with `bot_id` (and usually a
 * `bot_profile`); bot users are also flagged `is_bot` on `users.info`.
 * Returns undefined for human senders.
 */
export function slackBotSenderInfo(
  event: { bot_id?: string; bot_profile?: SlackBotProfile },
  userInfo?: SlackUserInfo,
): SlackBotSenderInfo | undefined {
  if (!event.bot_id && userInfo?.isBot !== true) return undefined;
  const botName = event.bot_profile?.name ?? userInfo?.displayName;
  return {
    ...(event.bot_id ? { botId: event.bot_id } : {}),
    ...(botName ? { botName } : {}),
    ...(event.bot_profile?.app_id ? { appId: event.bot_profile.app_id } : {}),
    ...(event.bot_profile?.team_id
      ? { teamId: event.bot_profile.team_id }
      : {}),
  };
}

/**
 * Human-readable contact note for a bot sender. Slack does not expose which
 * user owns/installed an app, so the note carries what Slack does provide:
 * the bot's name, Slack app ID, and workspace ID.
 */
export function slackBotContactNote(botSender: SlackBotSenderInfo): string {
  const details = [
    ...(botSender.appId ? [`Slack app ${botSender.appId}`] : []),
    ...(botSender.teamId ? [`workspace ${botSender.teamId}`] : []),
  ];
  const name = botSender.botName ? ` "${botSender.botName}"` : "";
  const suffix = details.length > 0 ? ` (${details.join(", ")})` : "";
  return `Automated Slack bot${name}${suffix} — messages from this contact are sent by an app, not a person.`;
}

/**
 * Merge a freshly resolved user profile into an already-normalized event.
 *
 * Normalization uses a cache-only user lookup, so a cold cache can leave the
 * actor unenriched. Besides display/trust fields, this re-runs bot-sender
 * classification against the original event: a bot user whose message carries
 * no top-level `bot_id` is only detectable via the profile's `is_bot`, which
 * is unavailable until this fetch completes.
 */
export function enrichNormalizedActor(
  normalized: NormalizedSlackEvent,
  userInfo: SlackUserInfo,
): void {
  const actor = normalized.event.actor;
  Object.assign(actor, slackUserActorFields(userInfo));
  if (!normalized.botSender) {
    const botSender = slackBotSenderInfo(
      normalized.event.raw as {
        bot_id?: string;
        bot_profile?: SlackBotProfile;
      },
      userInfo,
    );
    if (botSender) {
      normalized.botSender = botSender;
      actor.isBot = true;
    }
  }
}
