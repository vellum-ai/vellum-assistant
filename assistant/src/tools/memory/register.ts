import { getConfig } from "../../config/loader.js";
import { RiskLevel } from "../../permissions/types.js";
import type { ToolDefinition } from "../../providers/types.js";
import type { Tool, ToolContext, ToolExecutionResult } from "../types.js";
import {
  memoryDeleteDefinition,
  memoryRecallDefinition,
  memorySaveDefinition,
  memoryUpdateDefinition,
} from "./definitions.js";
import {
  handleMemoryDelete,
  handleMemoryRecall,
  handleMemorySave,
  handleMemoryUpdate,
} from "./handlers.js";

// ── memory_save ──────────────────────────────────────────────────────

class MemorySaveTool implements Tool {
  name = "memory_save";
  description = memorySaveDefinition.description;
  category = "memory";
  defaultRiskLevel = RiskLevel.Low;

  getDefinition(): ToolDefinition {
    return memorySaveDefinition;
  }

  async execute(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    const config = getConfig();
    return handleMemorySave(
      input,
      config,
      context.conversationId,
      context.requestId,
      context.memoryScopeId,
    );
  }
}

// ── memory_update ────────────────────────────────────────────────────

class MemoryUpdateTool implements Tool {
  name = "memory_update";
  description = memoryUpdateDefinition.description;
  category = "memory";
  defaultRiskLevel = RiskLevel.Low;

  getDefinition(): ToolDefinition {
    return memoryUpdateDefinition;
  }

  async execute(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    const config = getConfig();
    return handleMemoryUpdate(input, config, context.memoryScopeId);
  }
}

// ── memory_delete ────────────────────────────────────────────────────

class MemoryDeleteTool implements Tool {
  name = "memory_delete";
  description = memoryDeleteDefinition.description;
  category = "memory";
  defaultRiskLevel = RiskLevel.Low;

  getDefinition(): ToolDefinition {
    return memoryDeleteDefinition;
  }

  async execute(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    const config = getConfig();
    return handleMemoryDelete(input, config, context.memoryScopeId);
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

export const memorySaveTool = new MemorySaveTool();
export const memoryUpdateTool = new MemoryUpdateTool();
export const memoryDeleteTool = new MemoryDeleteTool();
export const memoryRecallTool = new MemoryRecallTool();
