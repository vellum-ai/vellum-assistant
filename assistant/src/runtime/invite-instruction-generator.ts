/**
 * Generative invite instructions for guardian-mediated channel invites.
 *
 * Uses the configured provider to generate natural, varied instructions
 * for guardians who need to help a contact message the assistant.
 * Falls back to a deterministic template when the provider is unavailable
 * or generation fails/times out.
 */

import {
  createTimeout,
  extractText,
  resolveConfiguredProvider,
  userMessage,
} from "../providers/provider-send-message.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("invite-instruction-generator");
const GENERATION_TIMEOUT_MS = 5_000;

export interface GeneratedInviteInstruction {
  instruction: string;
}

/**
 * Build a deterministic fallback instruction when LLM generation
 * is unavailable or fails.
 */
export function buildFallbackInstruction(params: {
  contactName?: string;
  channelLabel: string;
  channelHandle?: string;
  shareUrl?: string;
}): string {
  const contact = params.contactName || "the contact";
  const handle = params.channelHandle
    ? ` at ${params.channelHandle}`
    : ` on ${params.channelLabel}`;

  if (params.shareUrl) {
    return `Send ${contact} this link: ${params.shareUrl} — or tell them to message me${handle} with the code below.`;
  }
  return `Tell ${contact} to message me${handle} with the code below.`;
}

/**
 * Generate a natural-language invite instruction via the configured LLM.
 * Falls back to a static template on failure/timeout.
 */
export async function generateInviteInstruction(params: {
  contactName?: string;
  channelType: string;
  channelHandle?: string;
  shareUrl?: string;
}): Promise<string> {
  const channelLabel = channelDisplayLabel(params.channelType);
  const fallback = buildFallbackInstruction({
    ...params,
    channelLabel,
  });

  const resolved = resolveConfiguredProvider();
  if (!resolved) {
    return fallback;
  }

  const { signal, cleanup } = createTimeout(GENERATION_TIMEOUT_MS);

  try {
    const contactName = params.contactName || "the contact";
    const promptParts = [
      "Generate a short, natural instruction for a guardian who needs to invite someone to message an AI assistant.",
      "",
      `Contact name: ${contactName}`,
      `Channel: ${channelLabel}`,
    ];

    if (params.channelHandle) {
      promptParts.push(
        `Assistant's handle on this channel: ${params.channelHandle}`,
      );
    }

    if (params.shareUrl) {
      promptParts.push(`Invite link: ${params.shareUrl}`);
    }

    promptParts.push(
      "",
      "Requirements:",
      "- Speak from the assistant's perspective — use 'me' and 'I' (e.g., 'tell them to message me').",
      "- Do NOT include the invite code in the instruction — the code is displayed separately below.",
      "- Instead, reference 'the code below' or 'the code shown below'.",
      params.shareUrl
        ? "- Lead with the invite link as the primary action. Mention the code as a fallback/alternative."
        : "- Tell the guardian to instruct the contact to message the assistant on this channel with the code.",
      "- Keep it to 1-2 sentences, conversational and clear.",
      "- Do NOT use quotes or markdown formatting.",
      "",
      "Respond with ONLY the instruction text, nothing else.",
    );

    const response = await resolved.provider.sendMessage(
      [userMessage(promptParts.join("\n"))],
      undefined,
      undefined,
      { signal, config: { modelIntent: "latency-optimized" } },
    );

    const text = extractText(response)?.trim();
    if (text && text.length > 0 && text.length < 500) {
      return text;
    }

    log.warn(
      { raw: text },
      "Generated instruction failed validation, using fallback",
    );
    return fallback;
  } catch (err) {
    if (signal.aborted) {
      log.warn("Invite instruction generation timed out, using fallback");
    } else {
      log.warn({ err }, "Invite instruction generation failed, using fallback");
    }
    return fallback;
  } finally {
    cleanup();
  }
}

function channelDisplayLabel(type: string): string {
  switch (type) {
    case "telegram":
      return "Telegram";
    case "sms":
      return "SMS";
    case "email":
      return "Email";
    case "slack":
      return "Slack";
    case "voice":
      return "Voice";
    default:
      return type.charAt(0).toUpperCase() + type.slice(1);
  }
}
