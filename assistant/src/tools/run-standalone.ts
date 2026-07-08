/**
 * Execute a single registered tool in-process, outside the agent loop.
 *
 * This is the entry point behind `assistant tools run <name>`: the CLI runs
 * the tool directly from the filesystem (no daemon, no IPC), the same way the
 * memory-retrospective CLI runs its job in-process. It loads the tool registry
 * (core built-ins plus workspace tools discovered under the workspace dir) and
 * dispatches through the normal {@link ToolExecutor}.
 *
 * Permission model: execution runs non-interactive and non-guardian
 * (`trustClass: "unknown"`). Read-only / low-risk tools execute; any tool whose
 * permission check resolves to a prompt is auto-denied with a clear message in
 * the result rather than blocking (there is no client to approve it). This is
 * the least-privilege default — it never silently performs a side-effecting
 * action the agent loop would have asked a human to confirm.
 */

import { v4 as uuid } from "uuid";

import { PermissionPrompter } from "../permissions/prompter.js";
import { getWorkspaceDir } from "../util/platform.js";
import { ToolExecutor } from "./executor.js";
import {
  areCoreToolsInitialized,
  getTool,
  initializeTools,
} from "./registry.js";
import type { ToolContext } from "./types.js";

/** Thrown when the requested tool is not present in the registry. */
export class UnknownToolError extends Error {
  constructor(toolName: string) {
    super(
      `Unknown tool "${toolName}". Run 'assistant tools list' to see registered tools.`,
    );
    this.name = "UnknownToolError";
  }
}

/** Result of a standalone tool run, surfaced to the CLI for rendering. */
export interface StandaloneToolResult {
  toolName: string;
  content: string;
  isError: boolean;
  status?: string;
  riskLevel?: string;
  approvalMode?: string;
  approvalReason?: string;
  matchedTrustRuleId?: string;
}

/**
 * Run `toolName` with `input` directly in this process and return the result.
 *
 * @throws {UnknownToolError} when no tool of that name is registered.
 */
export async function runToolStandalone(
  toolName: string,
  input: Record<string, unknown>,
  opts?: { workingDir?: string; signal?: AbortSignal },
): Promise<StandaloneToolResult> {
  // Populate the registry from the filesystem. The daemon does this at
  // startup; a short-lived CLI process has to do it itself. Guarded so a
  // repeat call in the same process is a no-op.
  if (!areCoreToolsInitialized()) {
    await initializeTools();
  }

  const tool = getTool(toolName);
  if (!tool) {
    throw new UnknownToolError(toolName);
  }

  const workingDir = opts?.workingDir ?? getWorkspaceDir();

  // No interactive client is attached, so the prompter's sendToClient is never
  // exercised: with a non-guardian, non-interactive context the permission
  // checker auto-denies prompt decisions before reaching the prompter.
  const executor = new ToolExecutor(new PermissionPrompter(() => {}));

  const context: ToolContext = {
    conversationId: `cli-tools-run-${uuid()}`,
    workingDir,
    requestId: uuid(),
    isInteractive: false,
    trustClass: "unknown",
    signal: opts?.signal,
  };

  const result = await executor.execute(toolName, input, context);

  return {
    toolName,
    content: result.content,
    isError: result.isError,
    status: result.status,
    riskLevel: result.riskLevel,
    approvalMode: result.approvalMode,
    approvalReason: result.approvalReason,
    matchedTrustRuleId: result.matchedTrustRuleId,
  };
}
