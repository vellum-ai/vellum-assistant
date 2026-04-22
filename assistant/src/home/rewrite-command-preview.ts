import { getConfiguredProvider } from "../providers/provider-send-message.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("command-preview-rewriter");
const REWRITE_TIMEOUT_MS = 3000;
const REWRITE_MAX_TOKENS = 100;

const SYSTEM_PROMPT = `You rewrite technical computer commands into simple, human-readable descriptions.
Output ONLY the rewritten description — no quotes, no explanation, no preamble.
Keep it under 15 words. Use plain language a non-technical person would understand.
Examples:
- "ls -la ~/Desktop" → "View files on the desktop"
- "cat ~/.bashrc" → "Read shell configuration file"
- "rm -rf /tmp/cache" → "Delete temporary cache files"
- "grep -r 'password' ." → "Search files for the word 'password'"
- "curl https://api.example.com/users" → "Fetch user data from an API"`;

export async function rewriteCommandPreview(
  toolName: string,
  commandPreview: string,
): Promise<string | null> {
  try {
    const provider = await getConfiguredProvider("feedEventCopy");
    if (!provider) return null;

    const response = await provider.sendMessage(
      [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `Tool: ${toolName}\nCommand: ${commandPreview}`,
            },
          ],
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
    log.warn(
      { err, toolName, commandPreview },
      "Command preview rewrite failed",
    );
    return null;
  }
}
