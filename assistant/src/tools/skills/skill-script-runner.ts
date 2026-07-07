import { basename, join, resolve } from "node:path";

import { bundledToolRegistry } from "../../config/bundled-tool-registry.js";
import { computeSkillVersionHash } from "../../skills/version-hash.js";
import type { ExecutionTarget } from "../tool-types.js";
import type { ToolContext, ToolExecutionResult } from "../types.js";
import { runSkillToolScriptSandbox } from "./sandbox-runner.js";
import type { SkillToolScript } from "./script-contract.js";

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
  /** Whether this is a bundled (first-party) skill. When true and running inside
   *  a compiled binary, the runner uses the pre-imported bundled tool registry
   *  instead of a dynamic filesystem import. */
  bundled?: boolean;
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
  if (options?.target === "sandbox" && !options?.bundled) {
    return runSkillToolScriptSandbox(skillDir, executorPath, input, context, {
      timeoutMs: options.timeoutMs,
      expectedSkillVersionHash: options.expectedSkillVersionHash,
      skillDirHashResolver: options.skillDirHashResolver,
    });
  }

  // Host execution dynamically imports the executor into the daemon process —
  // full host code execution with no sandbox boundary. This is a first-party
  // capability reserved for bundled skills, which ship trusted, in-repo
  // executors. A non-bundled skill (managed, workspace, plugin, extra) that
  // declares `execution_target: host` must be refused: otherwise an
  // attacker-planted TOOLS.json — e.g. written into a managed skill dir via
  // scaffold_managed_skill companion files, or shipped in a third-party skill —
  // could get arbitrary code imported into the host process and auto-approved
  // under the low-risk threshold. Non-bundled skills must run their tools in the
  // sandbox (handled above); host execution here is a hard, fail-closed deny.
  if (options?.target === "host" && !options?.bundled) {
    return {
      content: `Skill tool "${executorPath}" requests host execution, which is only permitted for first-party bundled skills. Non-bundled skills must declare execution_target: "sandbox".`,
      isError: true,
    };
  }

  const scriptPath = resolve(join(skillDir, executorPath));
  const resolvedSkillDir = resolve(skillDir) + "/";
  if (!scriptPath.startsWith(resolvedSkillDir)) {
    return {
      content: `Skill tool script path "${executorPath}" escapes the skill directory`,
      isError: true,
    };
  }

  // Block execution if the skill has been modified since approval.
  if (options?.expectedSkillVersionHash) {
    const resolver = options.skillDirHashResolver ?? computeSkillVersionHash;
    let currentHash: string;
    try {
      currentHash = resolver(resolvedSkillDir);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: `Failed to compute skill version hash for "${resolvedSkillDir}": ${message}`,
        isError: true,
      };
    }
    if (currentHash !== options.expectedSkillVersionHash) {
      return {
        content: `Skill version mismatch: expected ${options.expectedSkillVersionHash} but current is ${currentHash}. The skill has been modified since it was approved. Please reload the skill to re-approve.`,
        isError: true,
      };
    }
  }

  // For bundled skills, use the pre-imported registry instead of dynamic import.
  // In compiled binaries the scripts' relative imports (e.g. ../../../../tools/...)
  // can't resolve because those modules are inside the virtual /$bunfs/ filesystem.
  let module: SkillToolScript | undefined;
  if (options?.bundled) {
    const registryKey = `${basename(skillDir)}:${executorPath}`;
    module = bundledToolRegistry.get(registryKey);
  }

  if (!module) {
    try {
      module = await import(scriptPath);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: `Failed to load skill tool script "${executorPath}": ${message}`,
        isError: true,
      };
    }
  }

  if (typeof module!.run !== "function") {
    return {
      content: `Skill tool script "${executorPath}" does not export a "run" function`,
      isError: true,
    };
  }

  try {
    return await module!.run(input, context);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: `Skill tool script "${executorPath}" threw an error: ${message}`,
      isError: true,
    };
  }
}
