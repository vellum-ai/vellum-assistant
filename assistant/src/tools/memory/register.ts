import { getConfig } from "../../config/loader.js";
import {
  handleRecall,
  handleRemember,
  type RecallInput,
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
        const ts = formatTimestamp(r.created);
        const meta =
          result.mode === "memory"
            ? `[${r.type}] ${ts} (confidence: ${r.confidence.toFixed(2)}, score: ${r.score.toFixed(3)})`
            : `[archive] ${ts}`;
        return `${meta}\n${r.content}`;
      })
      .join("\n\n---\n\n");

    return { content: formatted, isError: false };
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

function formatTimestamp(epochMs: number): string {
  const d = new Date(epochMs);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const yy = String(d.getFullYear()).slice(-2);
  const hh = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${mm}/${dd}/${yy} ${hh}:${min}`;
}

// ── Exported tool instances ──────────────────────────────────────────

export const rememberTool = new RememberTool();
export const recallTool = new RecallTool();
