import { getConfig } from "../../config/loader.js";
import { RiskLevel } from "../../permissions/types.js";
import type { ToolDefinition } from "../../providers/types.js";
import type { Tool, ToolContext, ToolExecutionResult } from "../types.js";
import {
  graphRecallDefinition,
  graphRememberDefinition,
} from "../../memory/graph/tools.js";
import {
  handleRecall,
  handleRemember,
  type RecallInput,
  type RememberInput,
} from "../../memory/graph/tool-handlers.js";

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
    const result = handleRemember(
      input as unknown as RememberInput,
      context.conversationId,
      context.memoryScopeId ?? "default",
    );
    return {
      content: result.message,
      isError: !result.success,
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
    const result = await handleRecall(
      input as unknown as RecallInput,
      config,
      context.memoryScopeId ?? "default",
    );

    if (result.results.length === 0) {
      return { content: "No results found.", isError: false };
    }

    const formatted = result.results
      .map((r) => {
        const meta =
          result.mode === "memory"
            ? `[${r.type}] (confidence: ${r.confidence.toFixed(2)}, score: ${r.score.toFixed(3)})`
            : `[archive]`;
        return `${meta}\n${r.content}`;
      })
      .join("\n\n---\n\n");

    return { content: formatted, isError: false };
  }
}

// ── Exported tool instances ──────────────────────────────────────────

export const rememberTool = new RememberTool();
export const recallTool = new RecallTool();
