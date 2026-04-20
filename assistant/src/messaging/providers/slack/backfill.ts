/**
 * Daemon-side Slack backfill helpers.
 *
 * These wrap the existing slackProvider adapter methods so callers (thread
 * recovery, DM context hydration) can fetch a small window of recent messages
 * without re-implementing connection resolution or token routing.
 *
 * Best-effort semantics: any failure (timeout, auth error, missing connection,
 * Slack API error) is logged at WARN and yields an empty array. Callers must
 * proceed without backfill rather than propagating the error — backfill is a
 * convenience, not a precondition.
 */
import { getLogger } from "../../../util/logger.js";
import type { Message } from "../../provider-types.js";
import { slackProvider } from "./adapter.js";

const log = getLogger("slack-backfill");

const DEFAULT_LIMIT = 50;

/**
 * Fetch the most recent messages in a Slack thread.
 *
 * Resolves the cached Slack connection, then delegates to
 * `slackProvider.getThreadReplies()`. Returns the messages mapped to the
 * platform-agnostic `Message` shape (with `threadId` already populated from
 * `thread_ts`). Returns `[]` on any error.
 */
export async function backfillThread(
  channelId: string,
  threadTs: string,
  opts?: { limit?: number },
): Promise<Message[]> {
  const limit = opts?.limit ?? DEFAULT_LIMIT;
  try {
    const connection = await slackProvider.resolveConnection?.();
    if (!slackProvider.getThreadReplies) {
      log.warn(
        { channelId, threadTs },
        "Slack provider does not implement getThreadReplies — returning []",
      );
      return [];
    }
    return await slackProvider.getThreadReplies(
      connection,
      channelId,
      threadTs,
      { limit },
    );
  } catch (err) {
    log.warn(
      { channelId, threadTs, err },
      "Slack thread backfill failed — returning []",
    );
    return [];
  }
}

/**
 * Fetch the most recent messages in a Slack DM (or any conversation).
 *
 * Resolves the cached Slack connection, then delegates to
 * `slackProvider.getHistory()`. The `before` option, when provided, is passed
 * through as Slack's `latest` cursor so callers can paginate backwards.
 * Returns `[]` on any error.
 */
export async function backfillDm(
  channelId: string,
  opts?: { limit?: number; before?: string },
): Promise<Message[]> {
  const limit = opts?.limit ?? DEFAULT_LIMIT;
  try {
    const connection = await slackProvider.resolveConnection?.();
    return await slackProvider.getHistory(connection, channelId, {
      limit,
      before: opts?.before,
    });
  } catch (err) {
    log.warn(
      { channelId, before: opts?.before, err },
      "Slack DM backfill failed — returning []",
    );
    return [];
  }
}
