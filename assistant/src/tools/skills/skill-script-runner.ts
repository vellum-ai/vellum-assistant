import type { ToolExecutionResult, ToolContext, ExecutionTarget } from '../types.js';
import type { SkillToolScript } from './script-contract.js';
import { join } from 'node:path';
import { runSkillToolScriptSandbox } from './sandbox-runner.js';

export interface RunSkillToolScriptOptions {
  /** Where to execute: 'host' runs in-process, 'sandbox' runs in an isolated subprocess. */
  target?: ExecutionTarget;
  /** Timeout in ms for sandbox execution. Ignored for host execution. */
  timeoutMs?: number;
}

/**
 * Execute a skill tool script on the host backend.
 * Dynamically imports the script file and calls its exported `run()` function.
 */
export async function runSkillToolScript(
  skillDir: string,
  executorPath: string,
  input: Record<string, unknown>,
  context: ToolContext,
  options?: RunSkillToolScriptOptions,
): Promise<ToolExecutionResult> {
  if (options?.target === 'sandbox') {
    return runSkillToolScriptSandbox(skillDir, executorPath, input, context, {
      timeoutMs: options.timeoutMs,
    });
  }

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
