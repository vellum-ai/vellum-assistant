import { getConfig } from "../../config/loader.js";
import { runAgenticRecall } from "../../memory/context-search/agent-runner.js";
import type { RecallInput } from "../../memory/context-search/types.js";
import {
  handleRemember,
  type RememberInput,
} from "../../memory/graph/tool-handlers.js";
import {
  graphRecallDefinition,
  graphRememberDefinition,
} from "../../memory/graph/tools.js";
import { RiskLevel } from "../../permissions/types.js";
import { isUntrustedTrustClass } from "../../runtime/actor-trust-resolver.js";
import type {
  ToolContext,
  ToolDefinition,
  ToolExecutionResult,
} from "../types.js";

// ── remember ────────────────────────────────────────────────────────

export const rememberTool = {
  name: "remember",
  description: graphRememberDefinition.description,
  category: "memory",
  executionTarget: "sandbox",
  defaultRiskLevel: RiskLevel.Low,
  input_schema: graphRememberDefinition.input_schema,

  async execute(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    const typedInput = input as unknown as RememberInput;

    // Incognito conversations must never produce memories. The lookup is a
    // lazy import so tool-handlers / register stay out of conversation-crud's
    // static module graph (a static import perturbs Bun's test-suite module
    // load order and trips partial `mock.module` mocks elsewhere).
    const { getConversation } = await import(
      "../../memory/conversation-crud.js"
    );
    if (getConversation(context.conversationId)?.incognito) {
      return {
        content: "remember is not available in incognito conversations",
        isError: true,
        ...(typedInput.finish_turn === true ? { yieldToUser: true } : {}),
      };
    }

    const result = handleRemember(
      typedInput,
      context.conversationId,
      "default",
      getConfig(),
    );
    return {
      content: result.message,
      isError: !result.success,
      ...(typedInput.finish_turn === true ? { yieldToUser: true } : {}),
    };
  },
} satisfies ToolDefinition;

// ── recall ──────────────────────────────────────────────────────────

export const recallTool = {
  name: "recall",
  description: graphRecallDefinition.description,
  category: "memory",
  executionTarget: "sandbox",
  defaultRiskLevel: RiskLevel.Low,
  input_schema: graphRecallDefinition.input_schema,

  async execute(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    if (isUntrustedTrustClass(context.trustClass)) {
      return {
        content:
          "Recall is only available to the guardian because it can read sensitive local context.",
        isError: true,
      };
    }

    // When an incognito conversation has opted out of factoring in memories,
    // existing memories must not be read — mirror the automatic-injection gate
    // in ConversationGraphMemory.prepareMemory so manual `recall` can't bypass
    // the user's "Factor in memories" off setting. Lazy import for the same
    // module-graph reason as the `remember` gate above.
    const { getConversation } = await import(
      "../../memory/conversation-crud.js"
    );
    const conversation = getConversation(context.conversationId);
    if (conversation?.incognito && !conversation.factorInMemories) {
      return {
        content:
          "recall is not available in this incognito conversation because factoring in memories is turned off",
        isError: true,
      };
    }

    const config = getConfig();
    const result = await runAgenticRecall(input as unknown as RecallInput, {
      workingDir: context.workingDir,
      conversationId: context.conversationId,
      config,
      signal: context.signal,
    });

    return { content: result.content, isError: false };
  },
} satisfies ToolDefinition;
