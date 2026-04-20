/**
 * Daemon-side Slack backfill helpers.
 *
 * These wrap the existing slackProvider adapter methods so callers (thread
 * recovery, DM context hydration) can fetch a small window of recent messages
 * without re-implementing connection resolution or token routing.
 *
 * Best-effort semantics: transient or auth failures (timeout, 401, missing
 * connection, generic Slack API errors) are logged at WARN and yield an empty
 * array. Callers proceed without backfill rather than propagating the error.
 *
 * Exception: `channel_not_found` is rethrown. In multi-account Slack setups it
 * typically signals that the resolved connection points at the wrong
 * workspace, and silently returning [] would mask that misconfiguration. Pass
 * the conversation's own account via `opts.account` so resolveConnection()
 * picks the right workspace.
 */
import { getLogger } from "../../../util/logger.js";
import type { Message } from "../../provider-types.js";
import { slackProvider } from "./adapter.js";

const log = getLogger("slack-backfill");

const DEFAULT_LIMIT = 50;

function isChannelNotFound(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /channel_not_found/i.test(msg);
}

/**
 * Fetch the most recent messages in a Slack thread.
 *
 * Resolves the cached Slack connection, then delegates to
 * `slackProvider.getThreadReplies()`. Returns the messages mapped to the
 * platform-agnostic `Message` shape (with `threadId` already populated from
 * `thread_ts`). Returns `[]` on transient errors; rethrows `channel_not_found`.
 */
export async function backfillThread(
  channelId: string,
  threadTs: string,
  opts?: { limit?: number; account?: string },
): Promise<Message[]> {
  const limit = opts?.limit ?? DEFAULT_LIMIT;
  try {
    const connection = await slackProvider.resolveConnection?.(opts?.account);
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
    if (isChannelNotFound(err)) {
      throw err;
    }
    log.warn(
      { channelId, threadTs, account: opts?.account, err },
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
 * Returns `[]` on transient errors; rethrows `channel_not_found`.
 */
export async function backfillDm(
  channelId: string,
  opts?: { limit?: number; before?: string; account?: string },
): Promise<Message[]> {
  const limit = opts?.limit ?? DEFAULT_LIMIT;
  try {
    const connection = await slackProvider.resolveConnection?.(opts?.account);
    return await slackProvider.getHistory(connection, channelId, {
      limit,
      before: opts?.before,
    });
  } catch (err) {
    if (isChannelNotFound(err)) {
      throw err;
    }
    log.warn(
      { channelId, before: opts?.before, account: opts?.account, err },
      "Slack DM backfill failed — returning []",
    );
    return [];
  }
}
