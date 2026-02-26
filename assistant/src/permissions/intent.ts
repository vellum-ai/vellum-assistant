import { isWorkspaceScopedInvocation } from '../permissions/workspace-policy.js';
import { isSideEffectTool } from '../tools/side-effects.js';
import { RiskLevel } from '../permissions/types.js';

export enum ToolIntent {
  Read = 'read',
  Write = 'write',
}

// Tools whose invocations are always classified as Write regardless of other signals.
const EXTERNAL_COMMUNICATION_PREFIXES = ['messaging_send', 'gmail_send'] as const;
const EXTERNAL_COMMUNICATION_EXACT = new Set(['gmail_forward', 'call_start', 'send_notification']);
const SCHEDULING_TOOLS = new Set(['schedule_create', 'schedule_update', 'schedule_delete']);

/**
 * Classify a tool invocation as Read or Write based on its name, inputs,
 * working directory, and risk level. This is orthogonal to risk — a tool
 * can be low-risk but still Write (e.g. scheduling), or high-risk but
 * still Read (e.g. host_file_read on a sensitive path).
 */
export function classifyIntent(
  toolName: string,
  input: Record<string, unknown>,
  workingDir: string,
  risk: RiskLevel,
): ToolIntent {
  // 1. Workspace-scoped tools: sandbox provides isolation, so reads are safe.
  if (
    toolName === 'file_read' ||
    (toolName === 'file_write' && isWorkspaceScopedInvocation(toolName, input, workingDir)) ||
    (toolName === 'file_edit' && isWorkspaceScopedInvocation(toolName, input, workingDir)) ||
    toolName === 'bash'
  ) {
    return ToolIntent.Read;
  }

  // 2. Host reads are unrestricted.
  if (toolName === 'host_file_read') return ToolIntent.Read;

  // 3. Information retrieval.
  if (toolName === 'web_search' || toolName === 'web_fetch') return ToolIntent.Read;

  // 4. Browser tools — sandboxed and user-visible.
  if (toolName.startsWith('browser_')) return ToolIntent.Read;

  // 5. Host mutations.
  if (toolName === 'host_file_write' || toolName === 'host_file_edit') return ToolIntent.Write;

  // 6. Host bash — risk-dependent.
  if (toolName === 'host_bash') {
    return risk === RiskLevel.Low ? ToolIntent.Read : ToolIntent.Write;
  }

  // 7. External communication.
  if (EXTERNAL_COMMUNICATION_EXACT.has(toolName)) return ToolIntent.Write;
  for (const prefix of EXTERNAL_COMMUNICATION_PREFIXES) {
    if (toolName.startsWith(prefix)) return ToolIntent.Write;
  }

  // 8. Scheduling.
  if (SCHEDULING_TOOLS.has(toolName)) return ToolIntent.Write;

  // 9. Network requests (proxy-authenticated, carries credentials).
  if (toolName === 'network_request') return ToolIntent.Write;

  // 10. Catch-all side-effect check for tools not already classified as Read.
  if (isSideEffectTool(toolName, input)) return ToolIntent.Write;

  // 11. Default: don't over-prompt.
  return ToolIntent.Read;
}
