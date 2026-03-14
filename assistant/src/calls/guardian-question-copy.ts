/**
 * Generative copy for guardian question threads.
 *
 * Uses the configured provider to generate an attention-oriented emoji-prefixed
 * thread title and a richer initial message. Falls back to deterministic copy
 * when the provider is unavailable or generation fails/times out.
 */

import {
  createTimeout,
  extractText,
  resolveConfiguredProvider,
  userMessage,
} from "../providers/provider-send-message.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("guardian-question-copy");

/** Timeout for the generative copy call (ms). */
const GENERATION_TIMEOUT_MS = 5_000;

export interface GuardianCopy {
  threadTitle: string;
  initialMessage: string;
}

/**
 * Build deterministic fallback copy when generation is unavailable or fails.
 */
export function buildFallbackCopy(questionText: string): GuardianCopy {
  return {
    threadTitle: `\u26A0\uFE0F ${questionText.slice(0, 70)}`,
    initialMessage: [
      "Your assistant needs your input during a phone call.",
      "",
      `Question: ${questionText}`,
      "",
      "Reply to this message with your answer.",
    ].join("\n"),
  };
}

/**
 * Generate guardian thread copy (title + initial message) via the configured
 * LLM provider. Returns deterministic fallback when the provider is unavailable,
 * generation times out, or any error occurs.
 */
export async function generateGuardianCopy(
  questionText: string,
  requestCode?: string,
): Promise<GuardianCopy> {
  const fallback = buildFallbackCopy(questionText);

  // If no provider is configured, return fallback immediately
  const resolved = await resolveConfiguredProvider();
  if (!resolved) {
    log.debug(
      "No provider available for guardian copy generation, using fallback",
    );
    return fallback;
  }

  const { signal, cleanup } = createTimeout(GENERATION_TIMEOUT_MS);

  try {
    const prompt = [
      "Generate a thread title and initial message for a guardian question during a live phone call.",
      "",
      `Question: ${questionText}`,
      ...(requestCode ? [`Reference code: ${requestCode}`] : []),
      "",
      "Requirements:",
      '- TITLE: An emoji-prefixed, attention-oriented, concise title (under 80 characters). Do NOT start with "Guardian question:". Use a relevant warning or alert emoji.',
      "- MESSAGE: A clear initial message that includes the question text, mentions this is a live phone call waiting for the user's input, and asks them to reply with their answer.",
      "",
      "Respond in exactly this format (no extra text):",
      "TITLE: <your title>",
      "MESSAGE: <your message>",
    ].join("\n");

    const response = await resolved.provider.sendMessage(
      [userMessage(prompt)],
      undefined,
      undefined,
      { signal, config: { modelIntent: "latency-optimized" } },
    );

    const text = extractText(response);
    const parsed = parseGeneratedCopy(text);

    if (parsed) {
      return parsed;
    }

    log.warn(
      { raw: text },
      "Failed to parse generated guardian copy, using fallback",
    );
    return fallback;
  } catch (err) {
    if (signal.aborted) {
      log.warn("Guardian copy generation timed out, using fallback");
    } else {
      log.warn({ err }, "Guardian copy generation failed, using fallback");
    }
    return fallback;
  } finally {
    cleanup();
  }
}

/**
 * Parse the structured TITLE/MESSAGE response from the model.
 * Returns null if the format is not matched.
 */
function parseGeneratedCopy(text: string): GuardianCopy | null {
  const titleMatch = text.match(/^TITLE:\s*(.+)/m);
  const messageMatch = text.match(/^MESSAGE:\s*([\s\S]+)/m);

  if (!titleMatch || !messageMatch) {
    return null;
  }

  const title = titleMatch[1].trim();
  const message = messageMatch[1].trim();

  // Sanity checks: title must be non-empty and under 80 chars, message must be non-empty
  if (!title || title.length > 80 || !message) {
    return null;
  }

  // Reject the old static prefix — the model is guided towards better titles but has final say
  if (/^guardian question:/i.test(title)) {
    return null;
  }

  return { threadTitle: title, initialMessage: message };
}
