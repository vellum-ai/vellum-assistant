import { RiskLevel } from '../../permissions/types.js';
import { getConfig } from '../../config/loader.js';
import type { Tool, ToolContext, ToolExecutionResult } from '../types.js';
import type { ToolDefinition } from '../../providers/types.js';
import { memorySearchDefinition, memorySaveDefinition, memoryUpdateDefinition } from './definitions.js';
import { handleMemorySearch, handleMemorySave, handleMemoryUpdate } from './handlers.js';

// ── memory_search ────────────────────────────────────────────────────

class MemorySearchTool implements Tool {
  name = 'memory_search';
  description = memorySearchDefinition.description;
  category = 'memory';
  defaultRiskLevel = RiskLevel.Low;

  getDefinition(): ToolDefinition {
    return memorySearchDefinition;
  }

  async execute(input: Record<string, unknown>, _context: ToolContext): Promise<ToolExecutionResult> {
    const config = getConfig();
    return handleMemorySearch(input, config);
  }
}

// ── memory_save ──────────────────────────────────────────────────────

class MemorySaveTool implements Tool {
  name = 'memory_save';
  description = memorySaveDefinition.description;
  category = 'memory';
  defaultRiskLevel = RiskLevel.Low;

  getDefinition(): ToolDefinition {
    return memorySaveDefinition;
  }

  async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolExecutionResult> {
    const config = getConfig();
    return handleMemorySave(input, config, context.conversationId, context.requestId);
  }
}

// ── memory_update ────────────────────────────────────────────────────

class MemoryUpdateTool implements Tool {
  name = 'memory_update';
  description = memoryUpdateDefinition.description;
  category = 'memory';
  defaultRiskLevel = RiskLevel.Low;

  getDefinition(): ToolDefinition {
    return memoryUpdateDefinition;
  }

  async execute(input: Record<string, unknown>, _context: ToolContext): Promise<ToolExecutionResult> {
    const config = getConfig();
    return handleMemoryUpdate(input, config);
  }
}

// ── Exported tool instances ──────────────────────────────────────────

export const memorySearchTool = new MemorySearchTool();
export const memorySaveTool = new MemorySaveTool();
export const memoryUpdateTool = new MemoryUpdateTool();
