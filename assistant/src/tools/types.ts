import type { RiskLevel } from '../permissions/types.js';
import type { ToolDefinition } from '../providers/types.js';

export interface ToolContext {
  workingDir: string;
  sessionId: string;
  conversationId: string;
}

export interface ToolExecutionResult {
  content: string;
  isError: boolean;
}

export interface Tool {
  name: string;
  description: string;
  category: string;
  defaultRiskLevel: RiskLevel;
  getDefinition(): ToolDefinition;
  execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolExecutionResult>;
}
