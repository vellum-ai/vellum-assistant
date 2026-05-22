import {
  createTimeout,
  extractText,
  getConfiguredProvider,
  userMessage,
} from "../providers/provider-send-message.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("query-complexity-router");

export type ComplexityTier = "speed" | "balanced" | "quality";

const CLASSIFICATION_TIMEOUT_MS = 5_000;

const SYSTEM_PROMPT = `You are a query complexity classifier. Given a user message, classify its complexity into exactly one tier.

Reply with a single word — one of: speed, balanced, quality

- speed: trivial queries — greetings, acknowledgements, simple yes/no questions, basic factual lookups, short commands, small talk
- balanced: moderate queries — explanations, summaries, standard coding tasks, general conversation, most everyday requests
- quality: complex queries — deep analysis, long-form creative writing, complex multi-step reasoning, debugging intricate code, architectural design, research synthesis

When uncertain, reply "balanced".`;

export async function classifyQueryComplexity(
  messageText: string,
): Promise<ComplexityTier | null> {
  const provider = await getConfiguredProvider("queryComplexityRouter");
  if (!provider) {
    log.warn("No provider available for query complexity routing");
    return null;
  }

  const truncated =
    messageText.length > 2000 ? messageText.slice(0, 2000) : messageText;

  const { signal, cleanup } = createTimeout(CLASSIFICATION_TIMEOUT_MS);
  try {
    const response = await provider.sendMessage(
      [userMessage(truncated)],
      undefined,
      SYSTEM_PROMPT,
      { signal },
    );
    const text = extractText(response).toLowerCase().trim();
    if (text === "speed" || text === "balanced" || text === "quality") {
      return text;
    }
    // Parse partial matches (model might say "speed." or "quality - because...")
    if (text.startsWith("speed")) return "speed";
    if (text.startsWith("quality")) return "quality";
    if (text.startsWith("balanced")) return "balanced";
    log.warn({ raw: text }, "Unexpected classifier output, defaulting to null");
    return null;
  } catch (err) {
    if (signal.aborted) {
      log.warn("Query complexity classification timed out");
    } else {
      log.warn({ err }, "Query complexity classification failed");
    }
    return null;
  } finally {
    cleanup();
  }
}

const PROFILE_MAP: Record<ComplexityTier, string> = {
  speed: "cost-optimized",
  balanced: "balanced",
  quality: "quality-optimized",
};

export function complexityTierToProfileKey(tier: ComplexityTier): string {
  return PROFILE_MAP[tier];
}
