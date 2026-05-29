import { getConfig } from "../../config/loader.js";
import { runAgenticRecall } from "../../memory/context-search/agent-runner.js";
import type { RecallInput } from "../../memory/context-search/types.js";
import {
  type DeleteMemoryInput,
  handleDeleteMemory,
  handleRemember,
  handleUpdateMemory,
  type RememberInput,
  type UpdateMemoryInput,
} from "../../memory/graph/tool-handlers.js";
import {
  graphDeleteMemoryDefinition,
  graphRecallDefinition,
  graphRememberDefinition,
  graphUpdateMemoryDefinition,
} from "../../memory/graph/tools.js";
import { RiskLevel } from "../../permissions/types.js";
import { isUntrustedTrustClass } from "../../runtime/actor-trust-resolver.js";
import type { Tool, ToolContext, ToolExecutionResult } from "../types.js";

// ── remember ────────────────────────────────────────────────────────

class RememberTool implements Tool {
  name = "remember";
  description = graphRememberDefinition.description;
  category = "memory";
  executionTarget = "sandbox" as const;
  defaultRiskLevel = RiskLevel.Low;
  input_schema = graphRememberDefinition.input_schema;

  async execute(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    const typedInput = input as unknown as RememberInput;
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
  }
}

// ── recall ──────────────────────────────────────────────────────────

class RecallTool implements Tool {
  name = "recall";
  description = graphRecallDefinition.description;
  category = "memory";
  executionTarget = "sandbox" as const;
  defaultRiskLevel = RiskLevel.Low;
  input_schema = graphRecallDefinition.input_schema;

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

    const config = getConfig();
    const result = await runAgenticRecall(input as unknown as RecallInput, {
      workingDir: context.workingDir,
      conversationId: context.conversationId,
      config,
      signal: context.signal,
    });

    return { content: result.content, isError: false };
  }
}

// ── delete_memory ────────────────────────────────────────────────────

class DeleteMemoryTool implements Tool {
  name = "delete_memory";
  description = graphDeleteMemoryDefinition.description;
  category = "memory";
  executionTarget = "sandbox" as const;
  defaultRiskLevel = RiskLevel.Low;
  input_schema = graphDeleteMemoryDefinition.input_schema;

  async execute(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    if (isUntrustedTrustClass(context.trustClass)) {
      return {
        content:
          "delete_memory is only available to the guardian — it modifies long-term memory.",
        isError: true,
      };
    }
    const typedInput = input as unknown as DeleteMemoryInput;
    const result = handleDeleteMemory(typedInput, getConfig());
    return {
      content: result.message,
      isError: !result.success,
      ...(typedInput.finish_turn === true ? { yieldToUser: true } : {}),
    };
  }
}

// ── update_memory ────────────────────────────────────────────────────

class UpdateMemoryTool implements Tool {
  name = "update_memory";
  description = graphUpdateMemoryDefinition.description;
  category = "memory";
  executionTarget = "sandbox" as const;
  defaultRiskLevel = RiskLevel.Low;
  input_schema = graphUpdateMemoryDefinition.input_schema;

  async execute(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    if (isUntrustedTrustClass(context.trustClass)) {
      return {
        content:
          "update_memory is only available to the guardian — it modifies long-term memory.",
        isError: true,
      };
    }
    const typedInput = input as unknown as UpdateMemoryInput;
    const result = handleUpdateMemory(
      typedInput,
      context.conversationId,
      getConfig(),
    );
    return {
      content: result.message,
      isError: !result.success,
      ...(typedInput.finish_turn === true ? { yieldToUser: true } : {}),
    };
  }
}

// ── Exported tool instances ──────────────────────────────────────────

export const rememberTool = new RememberTool();
export const recallTool = new RecallTool();
export const deleteMemoryTool = new DeleteMemoryTool();
export const updateMemoryTool = new UpdateMemoryTool();
