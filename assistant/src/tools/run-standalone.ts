/**
 * Execute a single registered tool in-process, outside the agent loop.
 *
 * This is the entry point behind `assistant tools run <name>`, and it runs in
 * whichever process resolves the name. Normally that is the daemon, reached
 * over IPC by the `tools_run_post` route, because the tool registry is
 * per-process and skill, plugin, and MCP tools live only there. With no daemon
 * running the CLI calls this directly instead, where the registry holds what it
 * loads from the filesystem: core built-ins plus workspace tools discovered
 * under the workspace dir. Either way, dispatch goes through the normal
 * {@link ToolExecutor}.
 *
 * Permission model: the caller is the guardian (`tools_run_post` admits local
 * principals holding `settings.write`, and the fallback path is the owner's own
 * shell), invoking a tool they named themselves with no client attached to
 * approve anything. The context says exactly that: `trustClass: "guardian"`,
 * `isInteractive: false`, `noApprovalChannel: true`. Read-only and low-risk
 * tools execute; anything whose permission check resolves to a prompt is denied
 * with that reason in the result, because `noApprovalChannel` also bars the
 * unattended auto-approve shortcuts a guardian would otherwise get.
 *
 * Guardian trust is what lets extension-owned tools run at all. The
 * sensitive-tool gate treats every MCP, plugin, and non-bundled-skill tool as
 * unvetted code that needs a human behind it; a person typing the tool's name
 * is that human, and no model chose it. Anything riskier than the guardian's
 * headless threshold still stops at the gate.
 */

import { v4 as uuid } from "uuid";

import { PermissionPrompter } from "../permissions/prompter.js";
import { getWorkspaceDir } from "../util/platform.js";
import { ToolExecutor } from "./executor.js";
import { resolveTool } from "./registry.js";
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
  // `resolveTool` lazily initializes the registry on first access (the daemon
  // does this at startup; a short-lived CLI process relies on the same lazy
  // ensure).
  const tool = await resolveTool(toolName);
  if (!tool) {
    throw new UnknownToolError(toolName);
  }

  const workingDir = opts?.workingDir ?? getWorkspaceDir();

  // No interactive client is attached, so the prompter's sendToClient is never
  // exercised: `noApprovalChannel` makes the permission checker deny prompt
  // decisions before reaching the prompter.
  const executor = new ToolExecutor(new PermissionPrompter(() => {}));

  const context: ToolContext = {
    conversationId: `cli-tools-run-${uuid()}`,
    workingDir,
    requestId: uuid(),
    isInteractive: false,
    trustClass: "guardian",
    noApprovalChannel: true,
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
