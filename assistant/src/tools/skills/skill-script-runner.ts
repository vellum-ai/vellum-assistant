import type { ToolExecutionResult, ToolContext, ExecutionTarget } from '../types.js';
import type { SkillToolScript } from './script-contract.js';
import { join, resolve } from 'node:path';
import { runSkillToolScriptSandbox } from './sandbox-runner.js';
import { computeSkillVersionHash } from '../../skills/version-hash.js';

export interface RunSkillToolScriptOptions {
  /** Where to execute: 'host' runs in-process, 'sandbox' runs in an isolated subprocess. */
  target?: ExecutionTarget;
  /** Timeout in ms for sandbox execution. Ignored for host execution. */
  timeoutMs?: number;
  /** The skill version hash that was valid at approval time. When set, the runner
   *  verifies the skill hasn't changed since the user approved it and blocks
   *  execution on mismatch. */
  expectedSkillVersionHash?: string;
  /** Function to compute the current version hash for a skill directory. Defaults
   *  to `computeSkillVersionHash` from the version-hash module. Provided as an
   *  option to support testing and custom resolution strategies. */
  skillDirHashResolver?: (skillDir: string) => string;
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
      expectedSkillVersionHash: options.expectedSkillVersionHash,
      skillDirHashResolver: options.skillDirHashResolver,
    });
  }

  const scriptPath = resolve(join(skillDir, executorPath));
  const resolvedSkillDir = resolve(skillDir) + '/';
  if (!scriptPath.startsWith(resolvedSkillDir)) {
    return { content: `Skill tool script path "${executorPath}" escapes the skill directory`, isError: true };
  }

  // Block execution if the skill has been modified since approval.
  if (options?.expectedSkillVersionHash) {
    const resolver = options.skillDirHashResolver ?? computeSkillVersionHash;
    const currentHash = resolver(resolvedSkillDir);
    if (currentHash !== options.expectedSkillVersionHash) {
      return {
        content: `Skill version mismatch: expected ${options.expectedSkillVersionHash} but current is ${currentHash}. The skill has been modified since it was approved. Please reload the skill to re-approve.`,
        isError: true,
      };
    }
  }

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
