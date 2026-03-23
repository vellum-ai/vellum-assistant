import { eq } from "drizzle-orm";

import { getDb } from "../../../../memory/db.js";
import { channelInboundEvents } from "../../../../memory/schema.js";
import { addReaction } from "../../../../messaging/providers/slack/client.js";
import { TokenExpiredError } from "../../../../security/token-manager.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";
import { getSlackConnection } from "../../slack/tools/shared.js";
import { getLogger } from "../../../../util/logger.js";
import {
  err,
  extractAllTweetUrls,
  getAuthenticatedUserId,
  getTwitterConnection,
  ok,
} from "./shared.js";

const log = getLogger("twitter-auto-like-scan");

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const messageText = input.message_text as string;
  if (!messageText) {
    return err("message_text is required.");
  }

  const reactionEmoji = (input.reaction_emoji as string) || "heart";

  // 1. Extract tweet URLs from message text
  const tweetUrls = extractAllTweetUrls(messageText);
  if (tweetUrls.length === 0) {
    return ok("No tweet URLs found.");
  }

  // 2. Get Twitter connection and authenticated user ID
  let conn;
  try {
    conn = await getTwitterConnection();
  } catch (e) {
    return err(
      `Twitter not connected. Load the twitter-oauth-setup skill to connect: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  let userId: string;
  try {
    userId = await getAuthenticatedUserId(conn);
  } catch (e) {
    return err(
      `Failed to get authenticated Twitter user: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  // 3. Like each tweet, collecting results
  const liked: string[] = [];
  const alreadyLiked: string[] = [];
  const failed: Array<{ tweetId: string; reason: string }> = [];

  for (const { tweetId } of tweetUrls) {
    try {
      const resp = await conn.request({
        method: "POST",
        path: `/2/users/${userId}/likes`,
        body: { tweet_id: tweetId },
      });

      const body = resp.body as { data?: { liked?: boolean } };

      if (resp.status === 200) {
        if (body.data?.liked === false) {
          alreadyLiked.push(tweetId);
        } else {
          liked.push(tweetId);
        }
      } else if (resp.status === 429) {
        failed.push({ tweetId, reason: "rate limited" });
      } else {
        failed.push({
          tweetId,
          reason: `HTTP ${resp.status}: ${JSON.stringify(body)}`,
        });
      }
    } catch (e: unknown) {
      if (e instanceof TokenExpiredError) {
        failed.push({ tweetId, reason: "auth expired" });
      } else {
        failed.push({
          tweetId,
          reason: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }

  // 4. Build result summary
  const parts: string[] = [];
  if (liked.length > 0) {
    parts.push(`Liked ${liked.length} tweet(s): ${liked.join(", ")}`);
  }
  if (alreadyLiked.length > 0) {
    parts.push(
      `Already liked ${alreadyLiked.length} tweet(s): ${alreadyLiked.join(", ")}`,
    );
  }
  if (failed.length > 0) {
    parts.push(
      `Failed ${failed.length} tweet(s): ${failed.map((f) => `${f.tweetId} (${f.reason})`).join(", ")}`,
    );
  }
  const resultSummary = parts.join(". ") + ".";

  // 5. Add Slack reaction if we have an inbound event
  if (context.inboundEventId) {
    try {
      const event = getDb()
        .select({
          sourceChannel: channelInboundEvents.sourceChannel,
          externalChatId: channelInboundEvents.externalChatId,
          sourceMessageId: channelInboundEvents.sourceMessageId,
        })
        .from(channelInboundEvents)
        .where(eq(channelInboundEvents.id, context.inboundEventId))
        .get();

      if (
        event &&
        event.sourceChannel === "slack" &&
        event.externalChatId &&
        event.sourceMessageId
      ) {
        try {
          const slackConn = await getSlackConnection();
          await addReaction(
            slackConn,
            event.externalChatId,
            event.sourceMessageId,
            reactionEmoji,
          );
        } catch (slackErr) {
          log.warn(
            { err: slackErr, channel: event.externalChatId },
            "Failed to add Slack reaction after auto-like",
          );
        }
      }
    } catch (dbErr) {
      log.warn(
        { err: dbErr, inboundEventId: context.inboundEventId },
        "Failed to query inbound event for Slack reaction",
      );
    }
  }

  return ok(resultSummary);
}
