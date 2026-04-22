import { CallSiteRoutingProvider } from "../providers/call-site-routing.js";
import { getConfiguredProvider } from "../providers/provider-send-message.js";
import { getProvider } from "../providers/registry.js";
import type { Provider } from "../providers/types.js";
import {
  buildGuardianActionGenerationPrompt,
  getGuardianActionFallbackMessage,
  GUARDIAN_ACTION_COPY_MAX_TOKENS,
  GUARDIAN_ACTION_COPY_SYSTEM_PROMPT,
  GUARDIAN_ACTION_COPY_TIMEOUT_MS,
  includesRequiredKeywords,
} from "../runtime/guardian-action-message-composer.js";
import type {
  GuardianActionCopyGenerator,
  GuardianFollowUpConversationGenerator,
  GuardianFollowUpDisposition,
  GuardianFollowUpTurnResult,
} from "../runtime/http-types.js";

/**
 * Create the daemon-owned guardian action copy generator that resolves
 * providers and calls `provider.sendMessage` to generate guardian action
 * copy text. Uses the `guardianQuestionCopy` call site so model selection
 * tracks the unified `llm.callSites` configuration.
 *
 * This keeps all provider awareness in the daemon lifecycle, away from
 * the runtime composer.
 */
export function createGuardianActionCopyGenerator(): GuardianActionCopyGenerator {
  return async (context, options = {}) => {
    const baseProvider = await getConfiguredProvider("guardianQuestionCopy");
    if (!baseProvider) return null;
    // Wrap so the per-call `callSite` can route to a different provider
    // transport when `llm.callSites.guardianQuestionCopy.provider` overrides
    // the default. Without this, callSite only affects request metadata.
    const provider = wrapWithCallSiteRouting(baseProvider);

    const fallbackText =
      options.fallbackText?.trim() || getGuardianActionFallbackMessage(context);
    const requiredKeywords = options.requiredKeywords
      ?.map((kw) => kw.trim())
      .filter((kw) => kw.length > 0);
    const prompt = buildGuardianActionGenerationPrompt(
      context,
      fallbackText,
      requiredKeywords,
    );

    const response = await provider.sendMessage(
      [{ role: "user", content: [{ type: "text", text: prompt }] }],
      [],
      GUARDIAN_ACTION_COPY_SYSTEM_PROMPT,
      {
        config: {
          max_tokens: options.maxTokens ?? GUARDIAN_ACTION_COPY_MAX_TOKENS,
          callSite: "guardianQuestionCopy",
        },
        signal: AbortSignal.timeout(
          options.timeoutMs ?? GUARDIAN_ACTION_COPY_TIMEOUT_MS,
        ),
      },
    );

    const block = response.content.find((entry) => entry.type === "text");
    const text = block && "text" in block ? block.text.trim() : "";
    if (!text) return null;
    const cleaned = text
      .replace(/^["'`]+/, "")
      .replace(/["'`]+$/, "")
      .trim();
    if (!cleaned) return null;
    if (!includesRequiredKeywords(cleaned, requiredKeywords)) return null;
    return cleaned;
  };
}

// ---------------------------------------------------------------------------
// Guardian follow-up conversation generator
// ---------------------------------------------------------------------------

const FOLLOWUP_CONVERSATION_TIMEOUT_MS = 8_000;
const FOLLOWUP_CONVERSATION_MAX_TOKENS = 300;

const FOLLOWUP_CONVERSATION_SYSTEM_PROMPT =
  "You are an assistant helping route a guardian's reply to a post-timeout follow-up message. " +
  "A voice caller asked a question, but the call timed out before the guardian could answer. " +
  "The guardian has now replied late, and was asked whether they want to call the caller back " +
  "or skip it. " +
  "Analyze the guardian's latest reply to determine their intent. " +
  "When uncertain, default to keep_pending and ask a clarifying question. " +
  "Always provide a natural, helpful reply along with your decision.";

const FOLLOWUP_CONVERSATION_TOOL_NAME = "followup_decision";

const FOLLOWUP_CONVERSATION_TOOL_SCHEMA = {
  name: FOLLOWUP_CONVERSATION_TOOL_NAME,
  description:
    "Record the guardian's follow-up decision and a natural reply. " +
    "Call this tool with the determined disposition and a reply to the guardian.",
  input_schema: {
    type: "object" as const,
    properties: {
      disposition: {
        type: "string",
        enum: ["call_back", "decline", "keep_pending"],
        description:
          "The guardian's intent: call_back to call the original caller, " +
          "decline to skip the follow-up, " +
          "keep_pending if the intent is unclear (ask for clarification).",
      },
      replyText: {
        type: "string",
        description: "A natural language reply to send back to the guardian.",
      },
    },
    required: ["disposition", "replyText"],
  },
};

const VALID_FOLLOWUP_DISPOSITIONS: ReadonlySet<string> = new Set([
  "call_back",
  "decline",
  "keep_pending",
]);

/**
 * Create the daemon-owned guardian follow-up conversation generator.
 * Uses tool/function calling to produce structured dispositions alongside
 * natural reply text. Follows the same pattern as
 * createApprovalConversationGenerator().
 */
export function createGuardianFollowUpConversationGenerator(): GuardianFollowUpConversationGenerator {
  return async (context) => {
    const baseProvider = await getConfiguredProvider("guardianQuestionCopy");
    if (!baseProvider) {
      throw new Error(
        "No configured provider available for follow-up conversation",
      );
    }
    const provider = wrapWithCallSiteRouting(baseProvider);

    const userPrompt = [
      `Original question from the voice call: "${context.questionText}"`,
      `Guardian's late answer: "${context.lateAnswerText}"`,
      `\nGuardian's latest reply: ${context.guardianReply}`,
    ].join("\n");

    const response = await provider.sendMessage(
      [{ role: "user", content: [{ type: "text", text: userPrompt }] }],
      [FOLLOWUP_CONVERSATION_TOOL_SCHEMA],
      FOLLOWUP_CONVERSATION_SYSTEM_PROMPT,
      {
        config: {
          max_tokens: FOLLOWUP_CONVERSATION_MAX_TOKENS,
          callSite: "guardianQuestionCopy",
        },
        signal: AbortSignal.timeout(FOLLOWUP_CONVERSATION_TIMEOUT_MS),
      },
    );

    // Extract the tool_use block from the response
    const toolUseBlock = response.content.find(
      (block) =>
        block.type === "tool_use" &&
        block.name === FOLLOWUP_CONVERSATION_TOOL_NAME,
    );

    if (!toolUseBlock || toolUseBlock.type !== "tool_use") {
      throw new Error(
        "Provider did not return a tool_use block for follow-up decision",
      );
    }

    const input = toolUseBlock.input as Record<string, unknown>;

    // Strict validation of the structured output
    const disposition = input.disposition;
    if (
      typeof disposition !== "string" ||
      !VALID_FOLLOWUP_DISPOSITIONS.has(disposition)
    ) {
      throw new Error(`Invalid disposition: ${String(disposition)}`);
    }

    const replyText = input.replyText;
    if (typeof replyText !== "string" || replyText.trim().length === 0) {
      throw new Error("Missing or empty replyText in tool_use response");
    }

    const result: GuardianFollowUpTurnResult = {
      disposition: disposition as GuardianFollowUpDisposition,
      replyText: replyText.trim(),
    };
    return result;
  };
}

/**
 * Wrap a base Provider so per-call `callSite` metadata can route the actual
 * transport to a different provider when `llm.callSites.<id>.provider`
 * differs from the default. Without this wrapper, only request metadata
 * reflects the callSite — the HTTP transport stays bound to the default.
 */
function wrapWithCallSiteRouting(base: Provider): Provider {
  return new CallSiteRoutingProvider(base, (name) => {
    try {
      return getProvider(name);
    } catch {
      return undefined;
    }
  });
}
