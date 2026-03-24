import { TokenExpiredError } from "../../../../security/token-manager.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";
import {
  err,
  extractTweetId,
  getAuthenticatedUserId,
  getTwitterConnection,
  ok,
} from "./shared.js";

export async function run(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const urlOrId = input.url_or_id as string;
  if (!urlOrId) {
    return err("url_or_id is required.");
  }

  const tweetId = extractTweetId(urlOrId);
  if (!tweetId) {
    return err(
      `Could not extract a tweet ID from "${urlOrId}". Provide a twitter.com/x.com URL or a numeric tweet ID.`,
    );
  }

  let conn;
  try {
    conn = await getTwitterConnection();
  } catch (e) {
    return err(
      `Twitter not connected. Load the twitter-oauth-setup skill to connect: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  const userId = await getAuthenticatedUserId(conn);

  try {
    const resp = await conn.request({
      method: "POST",
      path: `/2/users/${userId}/likes`,
      body: { tweet_id: tweetId },
    });

    const body = resp.body as { data?: { liked?: boolean } };

    if (resp.status === 200) {
      if (body.data?.liked === false) return ok("Tweet was already liked.");
      return ok(`Liked tweet ${tweetId}.`);
    }

    if (resp.status === 429) return err("Rate limited. Try again later.");

    return err(`Twitter API error (${resp.status}): ${JSON.stringify(body)}`);
  } catch (e: unknown) {
    if (e instanceof TokenExpiredError) {
      return err("Twitter auth expired. Re-run twitter-oauth-setup.");
    }
    throw e;
  }
}
