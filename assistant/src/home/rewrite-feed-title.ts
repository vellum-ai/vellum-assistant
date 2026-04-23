import { getConfiguredProvider } from "../providers/provider-send-message.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("feed-title-rewriter");
const REWRITE_TIMEOUT_MS = 3000;
const REWRITE_MAX_TOKENS = 60;

const SYSTEM_PROMPT = `You rewrite raw conversation titles into friendly, human-readable feed item titles.
Output ONLY the rewritten title — no quotes, no explanation, no preamble.
Keep it under 10 words. Use plain language.
If the input is already user-friendly, return it unchanged.
Examples:
- "Filing" → "Filed documents to knowledge base"
- "Heartbeat" → "Ran periodic check-in"
- "Runtime: process_user_message" → "Processed a message"
- "Background task" → "Completed a background task"
- "Scheduled: daily_digest" → "Ran your daily digest"`;

export async function rewriteFeedTitle(
  rawTitle: string,
): Promise<string | null> {
  try {
    const provider = await getConfiguredProvider("feedEventCopy");
    if (!provider) return null;

    const response = await provider.sendMessage(
      [
        {
          role: "user",
          content: [{ type: "text", text: rawTitle }],
        },
      ],
      [],
      SYSTEM_PROMPT,
      {
        config: {
          max_tokens: REWRITE_MAX_TOKENS,
          callSite: "feedEventCopy",
        },
        signal: AbortSignal.timeout(REWRITE_TIMEOUT_MS),
      },
    );

    const block = response.content.find((entry) => entry.type === "text");
    const text =
      block && "text" in block ? (block as { text: string }).text.trim() : "";
    if (!text) return null;
    return (
      text
        .replace(/^["'`]+/, "")
        .replace(/["'`]+$/, "")
        .trim() || null
    );
  } catch (err) {
    log.warn({ err, rawTitle }, "Feed title rewrite failed");
    return null;
  }
}
