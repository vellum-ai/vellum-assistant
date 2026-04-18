import { loadConfig } from "../config/loader.js";
import { CallSiteRoutingProvider } from "../providers/call-site-routing.js";
import { getProvider, listProviders } from "../providers/registry.js";
import type { Provider } from "../providers/types.js";
import {
  APPROVAL_COPY_MAX_TOKENS,
  APPROVAL_COPY_SYSTEM_PROMPT,
  APPROVAL_COPY_TIMEOUT_MS,
  buildGenerationPrompt,
  getFallbackMessage,
  includesRequiredKeywords,
} from "../runtime/approval-message-composer.js";
import type {
  ApprovalConversationDisposition,
  ApprovalConversationGenerator,
  ApprovalConversationResult,
  ApprovalCopyGenerator,
} from "../runtime/http-types.js";

// ---------------------------------------------------------------------------
// Approval conversation generator constants
// ---------------------------------------------------------------------------

const APPROVAL_CONVERSATION_TIMEOUT_MS = 8_000;
const APPROVAL_CONVERSATION_MAX_TOKENS = 300;

const APPROVAL_CONVERSATION_SYSTEM_PROMPT =
  "You are an assistant helping a user manage a pending tool approval request. " +
  "Analyze the user's message to determine if they are making a decision " +
  "(approve, reject, or cancel) or just asking a question / making conversation. " +
  "When uncertain, default to keep_pending — never approve or reject without clear intent. " +
  "For guardians: explain what tool is requesting approval and from whom. " +
  "Always provide a natural, helpful reply along with your decision.";

const APPROVAL_CONVERSATION_TOOL_NAME = "approval_decision";

const APPROVAL_CONVERSATION_TOOL_SCHEMA = {
  name: APPROVAL_CONVERSATION_TOOL_NAME,
  description:
    "Record the disposition of the approval conversation turn. " +
    "Call this tool with the determined disposition and a natural reply to the user.",
  input_schema: {
    type: "object" as const,
    properties: {
      disposition: {
        type: "string",
        enum: [
          "keep_pending",
          "approve_once",
          "approve_10m",
          "approve_conversation",
          "approve_always",
          "reject",
        ],
        description:
          "The decision: keep_pending if the user is asking questions or unclear, " +
          "approve_once to approve this single request, approve_10m to approve all " +
          "requests for 10 minutes, approve_conversation to approve all requests in this " +
          "conversation, approve_always to approve this tool permanently, reject to deny the request.",
      },
      replyText: {
        type: "string",
        description: "A natural language reply to send back to the user.",
      },
      targetRequestId: {
        type: "string",
        description:
          "The request ID of the specific pending approval being acted on. " +
          "Required when there are multiple pending approvals and the disposition is decision-bearing.",
      },
    },
    required: ["disposition", "replyText"],
  },
};

const VALID_DISPOSITIONS: ReadonlySet<string> = new Set([
  "keep_pending",
  "approve_once",
  "approve_10m",
  "approve_conversation",
  "approve_always",
  "reject",
]);

/**
 * Create the daemon-owned approval copy generator that resolves providers
 * and calls `provider.sendMessage` to generate approval copy text.
 * This keeps all provider awareness in the daemon lifecycle, away from
 * the runtime composer.
 */
export function createApprovalCopyGenerator(): ApprovalCopyGenerator {
  return async (context, options = {}) => {
    const config = loadConfig();
    let baseProvider: Provider;
    try {
      baseProvider = getProvider(config.llm.default.provider);
    } catch {
      return null;
    }
    // Wrap so per-call `callSite` can route to an alternative provider
    // transport when `llm.callSites.<id>.provider` overrides the default.
    const provider = wrapWithCallSiteRouting(baseProvider);

    const fallbackText =
      options.fallbackText?.trim() || getFallbackMessage(context);
    const requiredKeywords = options.requiredKeywords
      ?.map((kw) => kw.trim())
      .filter((kw) => kw.length > 0);
    const prompt = buildGenerationPrompt(
      context,
      fallbackText,
      requiredKeywords,
    );

    const response = await provider.sendMessage(
      [{ role: "user", content: [{ type: "text", text: prompt }] }],
      [],
      APPROVAL_COPY_SYSTEM_PROMPT,
      {
        config: {
          max_tokens: options.maxTokens ?? APPROVAL_COPY_MAX_TOKENS,
        },
        signal: AbortSignal.timeout(
          options.timeoutMs ?? APPROVAL_COPY_TIMEOUT_MS,
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

/**
 * Create the daemon-owned approval conversation generator that resolves
 * providers and uses tool_use / function calling for structured output.
 * Follows the same provider-aware pattern as createApprovalCopyGenerator().
 */
export function createApprovalConversationGenerator(): ApprovalConversationGenerator {
  return async (context) => {
    const config = loadConfig();
    if (!listProviders().includes(config.llm.default.provider)) {
      throw new Error("No provider available for approval conversation");
    }
    const provider = wrapWithCallSiteRouting(
      getProvider(config.llm.default.provider),
    );

    const pendingDescription = context.pendingApprovals
      .map((p) => `- Request ${p.requestId}: tool "${p.toolName}"`)
      .join("\n");

    const userPrompt = [
      `Role: ${context.role}`,
      `Tool requesting approval: "${context.toolName}"`,
      `Allowed actions: ${context.allowedActions.join(", ")}`,
      `Pending approvals:\n${pendingDescription}`,
      `\nUser message: ${context.userMessage}`,
    ].join("\n");

    const response = await provider.sendMessage(
      [{ role: "user", content: [{ type: "text", text: userPrompt }] }],
      [APPROVAL_CONVERSATION_TOOL_SCHEMA],
      APPROVAL_CONVERSATION_SYSTEM_PROMPT,
      {
        config: {
          max_tokens: APPROVAL_CONVERSATION_MAX_TOKENS,
        },
        signal: AbortSignal.timeout(APPROVAL_CONVERSATION_TIMEOUT_MS),
      },
    );

    // Extract the tool_use block from the response
    const toolUseBlock = response.content.find(
      (block) =>
        block.type === "tool_use" &&
        block.name === APPROVAL_CONVERSATION_TOOL_NAME,
    );

    if (!toolUseBlock || toolUseBlock.type !== "tool_use") {
      throw new Error(
        "Provider did not return a tool_use block for approval decision",
      );
    }

    const input = toolUseBlock.input as Record<string, unknown>;

    // Strict validation of the structured output
    const disposition = input.disposition;
    if (
      typeof disposition !== "string" ||
      !VALID_DISPOSITIONS.has(disposition)
    ) {
      throw new Error(`Invalid disposition: ${String(disposition)}`);
    }

    const replyText = input.replyText;
    if (typeof replyText !== "string" || replyText.trim().length === 0) {
      throw new Error("Missing or empty replyText in tool_use response");
    }

    const targetRequestId = input.targetRequestId;
    if (targetRequestId !== undefined && typeof targetRequestId !== "string") {
      throw new Error("Invalid targetRequestId in tool_use response");
    }

    const result: ApprovalConversationResult = {
      disposition: disposition as ApprovalConversationDisposition,
      replyText: replyText.trim(),
    };
    if (typeof targetRequestId === "string" && targetRequestId.length > 0) {
      result.targetRequestId = targetRequestId;
    }
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
