/**
 * Who the bot is, for the admission gate to recognise itself in a room.
 *
 * A group message addresses the bot by `@username` (a `mention` or
 * `bot_command` entity), by user id (a `text_mention` entity, used for
 * accounts without a username), or by replying to one of its posts, whose
 * `from.id` is the bot's. Both halves come from `getMe`, which is the Bot
 * API's own answer and the one Slack's `auth.test` is the analogue of.
 *
 * The token carries the user id as well: the Bot API shows it as
 * `123456:ABC-DEF...`, and every token issued has that shape. It is read as a
 * fallback so that a `getMe` outage degrades to "replies and text mentions
 * still admit" rather than "every room message drops".
 *
 * Cached per token, so a rotated token re-resolves and a stable one costs one
 * call per process. An identity that came from the token alone is held only
 * for {@link DEGRADED_IDENTITY_RETRY_MS}, so a `getMe` outage at the first
 * room message does not leave `@username` mentions unrecognised until the
 * next restart.
 */

import { credentialKey } from "../credential-key.js";
import type { ConfigFileCache } from "../config-file-cache.js";
import type { CredentialCache } from "../credential-cache.js";
import { getLogger } from "../logger.js";
import { callTelegramApi } from "./api.js";

const log = getLogger("telegram-bot-identity");

export interface TelegramBotIdentity {
  /** The bot's own Telegram user id, as a string like every other actor id. */
  userId: string;
  /** The bot's `@username` without the `@`, when known. */
  username?: string;
}

/** The user id embedded before the colon of a bot token, if the token has one. */
export function botUserIdFromToken(token: string): string | undefined {
  const match = /^(\d+):/.exec(token);
  return match ? match[1] : undefined;
}

type GetMeResult = { id?: number; username?: string };

/**
 * How long an identity resolved without `getMe` is trusted before the next
 * room update tries `getMe` again. Long enough that a Telegram outage does
 * not cost a call per message, short enough that recovery is noticed within
 * a minute.
 */
export const DEGRADED_IDENTITY_RETRY_MS = 60_000;

/**
 * A resolver that answers the bot's identity for the current token, or
 * `undefined` when there is no token to answer for.
 */
export function createTelegramBotIdentityResolver(
  caches?: {
    credentials?: CredentialCache;
    configFile?: ConfigFileCache;
  },
  now: () => number = Date.now,
): () => Promise<TelegramBotIdentity | undefined> {
  let cached:
    | {
        token: string;
        identity: TelegramBotIdentity;
        /** Set when `getMe` failed and the identity came from the token. */
        retryAfter?: number;
      }
    | undefined;
  let inFlight: Promise<TelegramBotIdentity | undefined> | undefined;

  return async () => {
    const token = await caches?.credentials?.get(
      credentialKey("telegram", "bot_token"),
    );
    if (!token) {
      return undefined;
    }
    if (
      cached?.token === token &&
      (cached.retryAfter === undefined || now() < cached.retryAfter)
    ) {
      return cached.identity;
    }
    if (inFlight) {
      return inFlight;
    }
    inFlight = (async () => {
      const fromToken = botUserIdFromToken(token);
      try {
        const me = await callTelegramApi<GetMeResult>("getMe", {}, caches);
        const userId = me.id != null ? String(me.id) : fromToken;
        if (!userId) {
          return undefined;
        }
        const identity: TelegramBotIdentity = {
          userId,
          ...(me.username ? { username: me.username } : {}),
        };
        cached = { token, identity };
        return identity;
      } catch (err) {
        log.warn(
          { err },
          "getMe failed; room admission falls back to the token's user id",
        );
        if (!fromToken) {
          return undefined;
        }
        const identity: TelegramBotIdentity = { userId: fromToken };
        cached = {
          token,
          identity,
          retryAfter: now() + DEGRADED_IDENTITY_RETRY_MS,
        };
        return identity;
      }
    })();
    try {
      return await inFlight;
    } finally {
      inFlight = undefined;
    }
  };
}
