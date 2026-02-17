import type { ToolExecutionResult, ToolContext } from '../types.js';
import type { SkillToolScript } from './script-contract.js';
import { join } from 'node:path';

/**
 * Execute a skill tool script on the host backend.
 * Dynamically imports the script file and calls its exported `run()` function.
 */
export async function runSkillToolScript(
  skillDir: string,
  executorPath: string,
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const scriptPath = join(skillDir, executorPath);

  let module: SkillToolScript;
  try {
    module = await import(scriptPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: `Failed to load skill tool script "${executorPath}": ${message}`, isError: true };
  }

  if (typeof module.run !== 'function') {
    return { content: `Skill tool script "${executorPath}" does not export a "run" function`, isError: true };
  }

  try {
    return await module.run(input, context);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: `Skill tool script "${executorPath}" threw an error: ${message}`, isError: true };
  }
}
