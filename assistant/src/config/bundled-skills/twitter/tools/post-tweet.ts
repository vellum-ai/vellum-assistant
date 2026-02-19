import type { ToolContext, ToolExecutionResult } from '../../../../tools/types.js';
import { postTweet, SessionExpiredError } from '../../../../twitter/client.js';

export async function run(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const tweetText = input.tweet_text as string | undefined;
  if (!tweetText?.trim()) {
    return {
      content: JSON.stringify({ ok: false, error: 'tweet_text is required' }),
      isError: true,
    };
  }

  try {
    const result = await postTweet(tweetText);
    return {
      content: JSON.stringify({
        ok: true,
        tweetId: result.tweetId,
        text: result.text,
        url: result.url,
      }),
    };
  } catch (err) {
    if (err instanceof SessionExpiredError) {
      return {
        content: JSON.stringify({
          ok: false,
          error: 'session_expired',
          message: 'Twitter session has expired. Run `vellum twitter refresh` to capture a fresh session.',
        }),
        isError: true,
      };
    }
    return {
      content: JSON.stringify({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      }),
      isError: true,
    };
  }
}
