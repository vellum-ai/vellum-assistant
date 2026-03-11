import { getConfig } from "../../config/loader.js";
import { RiskLevel } from "../../permissions/types.js";
import type { ToolDefinition } from "../../providers/types.js";
import type { Tool, ToolContext, ToolExecutionResult } from "../types.js";
import {
  memoryManageDefinition,
  memoryRecallDefinition,
} from "./definitions.js";
import {
  handleMemoryDelete,
  handleMemoryRecall,
  handleMemorySave,
  handleMemoryUpdate,
} from "./handlers.js";

// ── memory_manage ────────────────────────────────────────────────────

class MemoryManageTool implements Tool {
  name = "memory_manage";
  description = memoryManageDefinition.description;
  category = "memory";
  defaultRiskLevel = RiskLevel.Low;

  getDefinition(): ToolDefinition {
    return memoryManageDefinition;
  }

  async execute(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    const config = getConfig();
    switch (input.op) {
      case "save":
        return handleMemorySave(
          input,
          config,
          context.conversationId,
          context.requestId,
          context.memoryScopeId,
        );
      case "update":
        return handleMemoryUpdate(input, config, context.memoryScopeId);
      case "delete":
        return handleMemoryDelete(input, config, context.memoryScopeId);
      default:
        return {
          content: `Error: unknown op "${input.op}". Must be one of: save, update, delete`,
          isError: true,
        };
    }
  }
}

// ── memory_recall ────────────────────────────────────────────────────

class MemoryRecallTool implements Tool {
  name = "memory_recall";
  description = memoryRecallDefinition.description;
  category = "memory";
  defaultRiskLevel = RiskLevel.Low;

  getDefinition(): ToolDefinition {
    return memoryRecallDefinition;
  }

  async execute(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    const config = getConfig();
    return handleMemoryRecall(
      input,
      config,
      context.memoryScopeId,
      context.conversationId,
    );
  }
}

// ── Exported tool instances ──────────────────────────────────────────

export const memoryManageTool = new MemoryManageTool();
export const memoryRecallTool = new MemoryRecallTool();
