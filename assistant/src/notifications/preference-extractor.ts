/**
 * Preference extraction pipeline.
 *
 * Detects notification-related user statements in conversation messages
 * and extracts structured preference data. Uses a small/fast model
 * (haiku) with a focused prompt for lightweight detection + extraction.
 *
 * Examples of statements it should detect:
 * - "Use Telegram for urgent alerts"
 * - "Don't notify me on desktop during work calls"
 * - "Weeknights after 10pm: only critical notifications"
 */

import { getConfig } from "../config/loader.js";
import {
  createTimeout,
  extractToolUse,
  getConfiguredProvider,
  userMessage,
} from "../providers/provider-send-message.js";
import { getLogger } from "../util/logger.js";
import type { AppliesWhenConditions } from "./preferences-store.js";

const log = getLogger("notification-preference-extractor");

const EXTRACTION_TIMEOUT_MS = 10_000;

// ── Extraction result ──────────────────────────────────────────────────

export interface ExtractedPreference {
  preferenceText: string;
  appliesWhen: AppliesWhenConditions;
  priority: number;
}

export interface ExtractionResult {
  detected: boolean;
  preferences: ExtractedPreference[];
}

// ── System prompt ──────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a notification preference detector. Given a user message from a conversation, determine if it contains any notification preferences or routing instructions.

Notification preferences are statements about HOW, WHEN, or WHERE the user wants to receive notifications. Examples:
- "Use Telegram for urgent alerts"
- "Don't notify me on desktop during work calls"
- "Weeknights after 10pm: only critical notifications"
- "Send me everything on the desktop app"
- "Only bug me for high priority stuff"
- "Mute notifications between 11pm and 7am"
- "I prefer Telegram over desktop notifications"

If the message does NOT contain any notification preferences, respond with the tool setting detected=false and an empty preferences array.

If it DOES contain preferences, extract each one as a separate entry with:
- preferenceText: the natural language preference as stated
- appliesWhen: structured conditions (timeRange, channels, urgencyLevels, contexts)
- priority: 0 for general defaults, 1 for specific overrides, 2 for critical/urgent overrides

You MUST respond using the \`extract_notification_preferences\` tool.`;

// ── Tool definition ────────────────────────────────────────────────────

const EXTRACTION_TOOL = {
  name: "extract_notification_preferences",
  description: "Extract notification preferences from a user message",
  input_schema: {
    type: "object" as const,
    properties: {
      detected: {
        type: "boolean",
        description: "Whether the message contains notification preferences",
      },
      preferences: {
        type: "array",
        description: "Array of extracted preferences (empty if detected=false)",
        items: {
          type: "object",
          properties: {
            preferenceText: {
              type: "string",
              description:
                "The natural language preference as stated by the user",
            },
            appliesWhen: {
              type: "object",
              description:
                "Structured conditions for when this preference applies",
              properties: {
                timeRange: {
                  type: "object",
                  properties: {
                    after: {
                      type: "string",
                      description: "Start time in HH:MM format",
                    },
                    before: {
                      type: "string",
                      description: "End time in HH:MM format",
                    },
                  },
                },
                channels: {
                  type: "array",
                  items: { type: "string" },
                  description:
                    "Channels this preference applies to (e.g. telegram, vellum)",
                },
                urgencyLevels: {
                  type: "array",
                  items: { type: "string" },
                  description:
                    "Urgency levels this preference applies to (e.g. low, medium, high, critical)",
                },
                contexts: {
                  type: "array",
                  items: { type: "string" },
                  description:
                    "Situational contexts (e.g. work_calls, meetings, sleeping)",
                },
              },
            },
            priority: {
              type: "number",
              description:
                "Priority for conflict resolution: 0=general default, 1=specific override, 2=critical override",
            },
          },
          required: ["preferenceText", "appliesWhen", "priority"],
        },
      },
    },
    required: ["detected", "preferences"],
  },
};

// ── Core extraction function ───────────────────────────────────────────

export async function extractPreferences(
  message: string,
): Promise<ExtractionResult> {
  const provider = await getConfiguredProvider();
  if (!provider) {
    log.debug("No provider available for preference extraction");
    return { detected: false, preferences: [] };
  }

  const config = getConfig();
  const modelIntent = config.notifications.decisionModelIntent;

  const { signal, cleanup } = createTimeout(EXTRACTION_TIMEOUT_MS);

  try {
    const response = await provider.sendMessage(
      [userMessage(message)],
      [EXTRACTION_TOOL],
      SYSTEM_PROMPT,
      {
        config: {
          modelIntent,
          max_tokens: 1024,
          tool_choice: {
            type: "tool" as const,
            name: "extract_notification_preferences",
          },
        },
        signal,
      },
    );
    cleanup();

    const toolBlock = extractToolUse(response);
    if (!toolBlock) {
      log.debug("No tool_use block in preference extraction response");
      return { detected: false, preferences: [] };
    }

    const input = toolBlock.input as Record<string, unknown>;
    return validateExtractionOutput(input);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log.debug({ err: errMsg }, "Preference extraction failed");
    return { detected: false, preferences: [] };
  } finally {
    cleanup();
  }
}

// ── Validation ─────────────────────────────────────────────────────────

function validateExtractionOutput(
  input: Record<string, unknown>,
): ExtractionResult {
  if (typeof input.detected !== "boolean") {
    return { detected: false, preferences: [] };
  }

  if (!input.detected || !Array.isArray(input.preferences)) {
    return { detected: false, preferences: [] };
  }

  const preferences: ExtractedPreference[] = [];

  for (const raw of input.preferences) {
    if (typeof raw !== "object" || !raw) continue;
    const p = raw as Record<string, unknown>;

    if (typeof p.preferenceText !== "string" || !p.preferenceText.trim())
      continue;

    const appliesWhen: AppliesWhenConditions = {};
    if (p.appliesWhen && typeof p.appliesWhen === "object") {
      const aw = p.appliesWhen as Record<string, unknown>;
      if (aw.timeRange && typeof aw.timeRange === "object") {
        const tr = aw.timeRange as Record<string, unknown>;
        appliesWhen.timeRange = {
          after: typeof tr.after === "string" ? tr.after : undefined,
          before: typeof tr.before === "string" ? tr.before : undefined,
        };
      }
      if (Array.isArray(aw.channels)) {
        appliesWhen.channels = aw.channels.filter(
          (c): c is string => typeof c === "string",
        );
      }
      if (Array.isArray(aw.urgencyLevels)) {
        appliesWhen.urgencyLevels = aw.urgencyLevels.filter(
          (u): u is string => typeof u === "string",
        );
      }
      if (Array.isArray(aw.contexts)) {
        appliesWhen.contexts = aw.contexts.filter(
          (c): c is string => typeof c === "string",
        );
      }
    }

    const priority =
      typeof p.priority === "number"
        ? Math.max(0, Math.min(2, Math.round(p.priority)))
        : 0;

    preferences.push({
      preferenceText: p.preferenceText.trim(),
      appliesWhen,
      priority,
    });
  }

  return {
    detected: preferences.length > 0,
    preferences,
  };
}
