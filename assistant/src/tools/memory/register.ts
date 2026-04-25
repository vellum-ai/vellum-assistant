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
import type { ToolDefinition } from "../../providers/types.js";
import type { Tool, ToolContext, ToolExecutionResult } from "../types.js";

// ── remember ────────────────────────────────────────────────────────

class RememberTool implements Tool {
  name = "remember";
  description = graphRememberDefinition.description;
  category = "memory";
  defaultRiskLevel = RiskLevel.Low;

  getDefinition(): ToolDefinition {
    return graphRememberDefinition;
  }

  async execute(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    const typedInput = input as unknown as RememberInput;
    const result = handleRemember(
      typedInput,
      context.conversationId,
      context.memoryScopeId ?? "default",
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
  defaultRiskLevel = RiskLevel.Low;

  getDefinition(): ToolDefinition {
    return graphRecallDefinition;
  }

  async execute(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    const config = getConfig();
    const result = await runAgenticRecall(input as unknown as RecallInput, {
      workingDir: context.workingDir,
      conversationId: context.conversationId,
      memoryScopeId: context.memoryScopeId ?? "default",
      config,
      signal: context.signal,
    });

    return { content: result.content, isError: false };
  }
}

// ── Exported tool instances ──────────────────────────────────────────

export const rememberTool = new RememberTool();
export const recallTool = new RecallTool();
