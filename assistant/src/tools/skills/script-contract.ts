import type { ToolExecutionResult, ToolContext } from '../types.js';

/** The exported interface a skill tool script must implement. */
export interface SkillToolScript {
  run(input: Record<string, unknown>, context: ToolContext): Promise<ToolExecutionResult>;
}
