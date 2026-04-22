/**
 * Generative invite instructions.
 *
 * Uses the configured provider to generate a short, first-person instruction
 * telling the guardian how to invite a contact via a specific channel. Falls
 * back to a deterministic template when the provider is unavailable or
 * generation fails/times out.
 */

import {
  createTimeout,
  extractText,
  resolveConfiguredProvider,
  userMessage,
} from "../providers/provider-send-message.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("invite-instruction-generator");

/** Timeout for the generative instruction call (ms). */
const GENERATION_TIMEOUT_MS = 5_000;

/** Maximum allowed length for a generated instruction. */
const MAX_INSTRUCTION_LENGTH = 500;

// ---------------------------------------------------------------------------
// LLM-powered generation
// ---------------------------------------------------------------------------

/**
 * Generate an invite instruction via the configured LLM provider. Returns a
 * deterministic fallback when the provider is unavailable, generation times
 * out (5s), or the output fails validation.
 */
export async function generateInviteInstruction(params: {
  contactName?: string;
  channelType: string;
  channelHandle?: string;
  /** Whether a share URL is available (shown separately in the UI). */
  hasShareUrl?: boolean;
  /**
   * Actual share URL for the deterministic fallback only. Never sent to the
   * LLM — the URL contains the raw invite token which is a redemption
   * credential.
   */
  shareUrl?: string;
}): Promise<string> {
  const channelLabel = (() => {
    switch (params.channelType) {
      case "telegram":
        return "Telegram";
      case "email":
        return "Email";
      case "slack":
        return "Slack";
      case "phone":
        return "Voice";
      default:
        return (
          params.channelType.charAt(0).toUpperCase() +
          params.channelType.slice(1)
        );
    }
  })();
  const contact = params.contactName || "the contact";
  const handle = params.channelHandle
    ? ` at ${params.channelHandle}`
    : ` on ${channelLabel}`;
  const fallback = params.shareUrl
    ? `Send ${contact} this link: ${params.shareUrl} — or tell them to message me${handle} with the code below.`
    : `Tell ${contact} to message me${handle} with the code below.`;

  const resolved = await resolveConfiguredProvider(
    "inviteInstructionGenerator",
  );
  if (!resolved) {
    log.debug(
      "No provider available for invite instruction generation, using fallback",
    );
    return fallback;
  }

  const { signal, cleanup } = createTimeout(GENERATION_TIMEOUT_MS);

  try {
    const parts: string[] = [
      "Generate a 1–2 sentence instruction from the assistant's perspective telling the user how to invite a contact.",
      "",
      `Channel: ${channelLabel}`,
    ];
    if (params.contactName) {
      parts.push(`Contact name: ${params.contactName}`);
    }
    if (params.channelHandle) {
      parts.push(`Channel handle: ${params.channelHandle}`);
    }
    if (params.hasShareUrl) {
      parts.push("A share link is available (displayed separately in the UI).");
    } else {
      parts.push(
        "No share link is available for this channel. Do NOT mention sharing a link or URL.",
      );
    }
    parts.push(
      "",
      "Requirements:",
      '- Write from the assistant\'s perspective using first person ("message me"), NOT third person ("message the assistant").',
      "- Do NOT include the invite code — it is displayed separately in the UI.",
    );
    if (params.hasShareUrl) {
      parts.push(
        "- When a share link is available, mention that the user can share the link.",
      );
    }
    parts.push(
      "- Keep the instruction concise (1–2 sentences, under 500 characters).",
      '- Refer to the invite code as "the code below" since it is shown beneath this instruction.',
      "",
      "Respond with the instruction text only — no labels, no extra formatting.",
    );

    const prompt = parts.join("\n");

    const response = await resolved.provider.sendMessage(
      [userMessage(prompt)],
      undefined,
      undefined,
      { signal, config: { callSite: "inviteInstructionGenerator" } },
    );

    const text = extractText(response).trim();

    if (!text || text.length > MAX_INSTRUCTION_LENGTH) {
      log.warn(
        { length: text.length },
        "Generated invite instruction failed validation, using fallback",
      );
      return fallback;
    }

    return text;
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
