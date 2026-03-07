import { getConfig } from "../../config/loader.js";
import { RiskLevel } from "../../permissions/types.js";
import type { ToolDefinition } from "../../providers/types.js";
import type { Tool, ToolContext, ToolExecutionResult } from "../types.js";
import {
  memoryRecallDefinition,
  memorySaveDefinition,
  memorySearchDefinition,
  memoryUpdateDefinition,
} from "./definitions.js";
import {
  handleMemoryRecall,
  handleMemorySave,
  handleMemorySearch,
  handleMemoryUpdate,
} from "./handlers.js";

// ── memory_search ────────────────────────────────────────────────────

class MemorySearchTool implements Tool {
  name = "memory_search";
  description = memorySearchDefinition.description;
  category = "memory";
  defaultRiskLevel = RiskLevel.Low;

  getDefinition(): ToolDefinition {
    return memorySearchDefinition;
  }

  async execute(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    const config = getConfig();
    return handleMemorySearch(input, config, context.memoryScopeId);
  }
}

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
    return handleMemoryRecall(input, config, context.memoryScopeId);
  }
}

// ── Exported tool instances ──────────────────────────────────────────

export const memorySearchTool = new MemorySearchTool();
export const memorySaveTool = new MemorySaveTool();
export const memoryUpdateTool = new MemoryUpdateTool();
export const memoryRecallTool = new MemoryRecallTool();
