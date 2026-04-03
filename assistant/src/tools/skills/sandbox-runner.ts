import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { computeSkillVersionHash } from "../../skills/version-hash.js";
import { buildSanitizedEnv } from "../terminal/safe-env.js";
import { wrapCommand } from "../terminal/sandbox.js";
import type { ToolContext, ToolExecutionResult } from "../types.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_CHARS = 50_000;

/**
 * Wrapper script that imports the target skill tool script, feeds it
 * JSON input via an env var, and prints the ToolExecutionResult as JSON
 * to stdout. This runs inside the sandbox subprocess.
 */
function buildRunnerSource(scriptPath: string): string {
  return `
const mod = await import(${JSON.stringify(scriptPath)});

if (typeof mod.run !== 'function') {
  console.log(JSON.stringify({ __skill_error: 'Script does not export a "run" function' }));
  process.exit(1);
}

let input;
try {
  input = JSON.parse(process.env.__SKILL_INPUT_JSON ?? '{}');
} catch {
  console.log(JSON.stringify({ __skill_error: 'Invalid JSON in __SKILL_INPUT_JSON' }));
  process.exit(1);
}

let context;
try {
  context = JSON.parse(process.env.__SKILL_CONTEXT_JSON ?? '{}');
} catch {
  context = {};
}

try {
  const result = await mod.run(input, context);
  console.log(JSON.stringify({ __skill_result: result }));
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.log(JSON.stringify({ __skill_result: { content: 'Script threw an error: ' + message, isError: true } }));
}
`;
}

/**
 * Execute a skill tool script in a sandboxed subprocess.
 *
 * Follows a subprocess isolation pattern: writes a runner script to a temp dir,
 * spawns it via the sandbox backend, passes input through env vars,
 * and reads a structured JSON result from stdout.
 */
export async function runSkillToolScriptSandbox(
  skillDir: string,
  executorPath: string,
  input: Record<string, unknown>,
  context: ToolContext,
  options?: {
    timeoutMs?: number;
    expectedSkillVersionHash?: string;
    skillDirHashResolver?: (skillDir: string) => string;
  },
): Promise<ToolExecutionResult> {
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
    try {
      const resolver = options.skillDirHashResolver ?? computeSkillVersionHash;
      const currentHash = resolver(resolvedSkillDir);
      if (currentHash !== options.expectedSkillVersionHash) {
        return {
          content: `Skill version mismatch: expected ${options.expectedSkillVersionHash} but current is ${currentHash}. The skill has been modified since it was approved. Please reload the skill to re-approve.`,
          isError: true,
        };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: `Failed to verify skill version hash for "${executorPath}": ${message}`,
        isError: true,
      };
    }
  }

  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const runDir = join(skillDir, ".vellum-skill-run", randomUUID());

  try {
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, "__skill_runner.ts"),
      buildRunnerSource(scriptPath),
      "utf-8",
    );

    return await spawnRunner(runDir, input, context, timeoutMs, executorPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: `Failed to run skill tool script "${executorPath}" in sandbox: ${message}`,
      isError: true,
    };
  } finally {
    try {
      rmSync(runDir, { recursive: true, force: true });
    } catch {
      // best effort cleanup
    }
  }
}

function spawnRunner(
  runDir: string,
  input: Record<string, unknown>,
  context: ToolContext,
  timeoutMs: number,
  executorPath: string,
): Promise<ToolExecutionResult> {
  return new Promise<ToolExecutionResult>((resolve) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;

    // The assistant runs exclusively in Docker or platform-managed
    // environments where the container provides isolation.
    const sandboxConfig = { enabled: false } as const;

    const bunRunCmd = "bun run __skill_runner.ts";
    const wrapped = wrapCommand(bunRunCmd, runDir, sandboxConfig);

    const env = buildSanitizedEnv();
    env.__SKILL_INPUT_JSON = JSON.stringify(input);
    // Pass a serializable subset of context to the subprocess
    env.__SKILL_CONTEXT_JSON = JSON.stringify({
      workingDir: context.workingDir,
      conversationId: context.conversationId,
    });

    const child = spawn(wrapped.command, wrapped.args, {
      cwd: runDir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        // Process group may have already exited.
      }
    }, timeoutMs);

    // Cooperative cancellation via AbortSignal
    const onAbort = () => {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        // Process group may have already exited.
      }
    };
    if (context.signal) {
      if (context.signal.aborted) {
        try {
          process.kill(-child.pid!, "SIGKILL");
        } catch {
          // Process group may have already exited.
        }
      } else {
        context.signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    child.stdout.on("data", (data: Buffer) => stdoutChunks.push(data));
    child.stderr.on("data", (data: Buffer) => stderrChunks.push(data));

    child.on("close", (code) => {
      clearTimeout(timer);
      context.signal?.removeEventListener("abort", onAbort);

      if (timedOut) {
        resolve({
          content: `Skill tool script "${executorPath}" timed out after ${timeoutMs}ms`,
          isError: true,
          status: "timeout",
        });
        return;
      }

      const stdout = Buffer.concat(stdoutChunks).toString();
      const stderr = Buffer.concat(stderrChunks).toString();

      // Parse structured result from stdout
      const result = parseSkillResult(stdout, executorPath);
      if (result) {
        resolve(result);
        return;
      }

      // No structured result - fall back to raw output
      if (code !== 0) {
        const truncatedStderr =
          stderr.length > MAX_OUTPUT_CHARS
            ? stderr.slice(0, MAX_OUTPUT_CHARS) + "\n[stderr truncated]"
            : stderr;
        resolve({
          content: `Skill tool script "${executorPath}" exited with code ${code}:\n${truncatedStderr}`,
          isError: true,
        });
        return;
      }

      const truncatedStdout =
        stdout.length > MAX_OUTPUT_CHARS
          ? stdout.slice(0, MAX_OUTPUT_CHARS) + "\n[stdout truncated]"
          : stdout;
      resolve({ content: truncatedStdout, isError: false });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      context.signal?.removeEventListener("abort", onAbort);
      resolve({
        content: `Failed to spawn skill tool script "${executorPath}": ${err.message}`,
        isError: true,
      });
    });
  });
}

/**
 * Scan stdout for the last occurrence of our structured result marker.
 * Uses a backward-scanning approach to find the last valid result line.
 */
function parseSkillResult(
  stdout: string,
  executorPath: string,
): ToolExecutionResult | null {
  let searchFrom = stdout.length;
  while (searchFrom > 0) {
    const markerIdx = stdout.lastIndexOf("__skill_result", searchFrom - 1);
    if (markerIdx === -1) break;

    const lineStart = stdout.lastIndexOf("\n", markerIdx) + 1;
    const lineEnd = stdout.indexOf("\n", markerIdx);
    const line = stdout.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);

    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object" && "__skill_result" in parsed) {
        const result = parsed.__skill_result;
        if (result && typeof result === "object" && "content" in result) {
          return result as ToolExecutionResult;
        }
      }
    } catch {
      // malformed line - keep scanning
    }
    searchFrom = lineStart;
  }

  // Check for error marker
  searchFrom = stdout.length;
  while (searchFrom > 0) {
    const markerIdx = stdout.lastIndexOf("__skill_error", searchFrom - 1);
    if (markerIdx === -1) break;

    const lineStart = stdout.lastIndexOf("\n", markerIdx) + 1;
    const lineEnd = stdout.indexOf("\n", markerIdx);
    const line = stdout.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);

    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object" && "__skill_error" in parsed) {
        return {
          content: `Skill tool script "${executorPath}": ${parsed.__skill_error}`,
          isError: true,
        };
      }
    } catch {
      // malformed line - keep scanning
    }
    searchFrom = lineStart;
  }

  return null;
}
