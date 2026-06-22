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
import { resolveCapabilities } from "../../runtime/capabilities.js";
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
    if (!resolveCapabilities(context.trustClass).canAccessMemory) {
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
  },
} satisfies ToolDefinition;

// ── delete_memory ────────────────────────────────────────────────────

export const deleteMemoryTool = {
  name: "delete_memory",
  description: graphDeleteMemoryDefinition.description,
  category: "memory",
  executionTarget: "sandbox",
  defaultRiskLevel: RiskLevel.Low,
  input_schema: graphDeleteMemoryDefinition.input_schema,

  async execute(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    if (!resolveCapabilities(context.trustClass).canAccessMemory) {
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
  },
} satisfies ToolDefinition;

// ── update_memory ────────────────────────────────────────────────────

export const updateMemoryTool = {
  name: "update_memory",
  description: graphUpdateMemoryDefinition.description,
  category: "memory",
  executionTarget: "sandbox",
  defaultRiskLevel: RiskLevel.Low,
  input_schema: graphUpdateMemoryDefinition.input_schema,

  async execute(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    if (!resolveCapabilities(context.trustClass).canAccessMemory) {
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
  },
} satisfies ToolDefinition;
