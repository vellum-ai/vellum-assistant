import { isAssistantFeatureFlagEnabled } from "../config/assistant-feature-flags.js";
import { getConfig } from "../config/loader.js";
import type { AssistantConfig } from "../config/types.js";
import { RiskLevel } from "../permissions/types.js";
import { getLogger } from "../util/logger.js";
import type {
  ToolContext,
  ToolDefinition,
  ToolExecutionResult,
} from "./types.js";

const log = getLogger("no-response-tool");

export const NO_RESPONSE_TOOL_NAME = "no_response";

const NO_RESPONSE_TOOL_FLAG = "no-response-tool" as const;

/**
 * Kill switch for the tool-based silence signal. Default-enabled; when the
 * flag is off, the tool is hidden from channel turns and the turn context
 * falls back to prompting the legacy `<no_response/>` text sentinel
 * (delivery-side sentinel handling is always active, so the off state is
 * exactly the pre-tool behavior).
 *
 * Tolerates an unloaded config (e.g. isolated tests): flag resolution reads
 * only the override cache and the registry default, so an empty config is
 * safe and keeps the kill switch effective even before config load.
 */
export function isNoResponseToolEnabled(): boolean {
  let config: AssistantConfig;
  try {
    config = getConfig();
  } catch {
    config = {} as AssistantConfig;
  }
  return isAssistantFeatureFlagEnabled(NO_RESPONSE_TOOL_FLAG, config);
}

/**
 * Turn-control tool for channel conversations: the model calls it to end the
 * turn without posting any reply. The result sets `yieldToUser`, so the agent
 * loop pushes the tool_result into history (keeping the provider's
 * tool_use/tool_result pairing valid) and stops without another LLM call —
 * the model never gets a follow-up inference in which it could talk itself
 * into replying anyway.
 *
 * Exposed only on channel conversations (Slack, Telegram, ...) — see the
 * gate in `conversation-tool-setup.ts`. Vellum-native surfaces always reply.
 */
export const noResponseTool = {
  name: NO_RESPONSE_TOOL_NAME,
  description:
    "End the current turn WITHOUT sending any reply to the channel. Use this " +
    "when the latest message does not call for a response from you — e.g. " +
    "people talking among themselves, simple acknowledgements ('thanks', " +
    "'+1', 'sounds good'), reactions, or thread chatter that is not directed " +
    "at you. Call this tool on its own, without writing any reply text. " +
    "After it runs, your turn ends immediately and nothing is posted.",
  category: "conversation",
  executionTarget: "sandbox",
  defaultRiskLevel: RiskLevel.Low,
  input_schema: {
    type: "object",
    properties: {
      reason: {
        type: "string",
        description:
          "Optional one-line note on why no reply is needed (recorded in logs only; never shown in the channel).",
      },
    },
    required: [],
  },

  async execute(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    log.info(
      {
        conversationId: context.conversationId,
        reason: typeof input.reason === "string" ? input.reason : undefined,
      },
      "Model elected to stay silent for this turn",
    );
    return {
      content: "Acknowledged — no reply will be posted for this turn.",
      isError: false,
      yieldToUser: true,
    };
  },
} satisfies ToolDefinition;
