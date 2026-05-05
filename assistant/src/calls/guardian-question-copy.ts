/**
 * Generative copy for guardian question conversations.
 *
 * Uses the configured provider to generate an attention-oriented emoji-prefixed
 * conversation title and a richer initial message. Falls back to deterministic copy
 * when the provider is unavailable or generation fails/times out.
 */

/** Timeout for the generative copy call (ms). */

export interface GuardianCopy {
  conversationTitle: string;
  initialMessage: string;
}

/**
 * Build deterministic fallback copy when generation is unavailable or fails.
 */
export function buildFallbackCopy(questionText: string): GuardianCopy {
  return {
    conversationTitle: `\u26A0\uFE0F ${questionText.slice(0, 70)}`,
    initialMessage: [
      "Your assistant needs your input during a phone call.",
      "",
      `Question: ${questionText}`,
      "",
      "Reply to this message with your answer.",
    ].join("\n"),
  };
}
