import { consumeGrantForInvocation } from '../approvals/approval-primitive.js';
import { isToolBlocked } from '../security/parental-control-store.js';
import { computeToolApprovalDigest } from '../security/tool-approval-digest.js';
import { getTaskRunRules } from '../tasks/ephemeral-permissions.js';
import { getLogger } from '../util/logger.js';
import { enforceGuardianOnlyPolicy } from './guardian-control-plane-policy.js';
import { getAllTools, getTool } from './registry.js';
import { isSideEffectTool } from './side-effects.js';
import type { ExecutionTarget, Tool, ToolContext, ToolExecutionResult, ToolLifecycleEvent } from './types.js';

const log = getLogger('tool-approval-handler');

function isUntrustedGuardianActorRole(role: ToolContext['guardianActorRole']): boolean {
  return role === 'non-guardian' || role === 'unverified_channel';
}

function requiresGuardianApprovalForActor(
  toolName: string,
  input: Record<string, unknown>,
  executionTarget: ExecutionTarget,
): boolean {
  // Side-effect tools always require guardian approval for untrusted actors.
  // Read-only host execution is also blocked because it can leak sensitive
  // local information (e.g. shell/file reads).
  return isSideEffectTool(toolName, input) || executionTarget === 'host';
}

function guardianApprovalDeniedMessage(
  actorRole: ToolContext['guardianActorRole'],
  toolName: string,
): string {
  if (actorRole === 'unverified_channel') {
    return `Permission denied for "${toolName}": this action requires guardian approval from a verified channel identity.`;
  }
  return `Permission denied for "${toolName}": this action requires guardian approval and the current actor is not the guardian.`;
}

export type PreExecutionGateResult =
  | { allowed: true; tool: Tool; grantConsumed?: boolean }
  | { allowed: false; result: ToolExecutionResult };

/**
 * Handles pre-execution approval gates: abort checks, parental controls,
 * guardian policy, allowed-tool-set gating, and task-run preflight checks.
 * These run before the interactive permission prompt flow.
 */
export class ToolApprovalHandler {
  /**
   * Evaluate all pre-execution approval gates for a tool invocation.
   * Returns the resolved Tool if all gates pass, or an early-return
   * ToolExecutionResult if any gate blocks execution.
   */
  async checkPreExecutionGates(
    name: string,
    input: Record<string, unknown>,
    context: ToolContext,
    executionTarget: ExecutionTarget,
    riskLevel: string,
    startTime: number,
    emitLifecycleEvent: (event: ToolLifecycleEvent) => void,
  ): Promise<PreExecutionGateResult> {
    // Bail out immediately if the session was aborted before this tool started.
    if (context.signal?.aborted) {
      const durationMs = Date.now() - startTime;
      emitLifecycleEvent({
        type: 'error',
        toolName: name,
        executionTarget,
        input,
        workingDir: context.workingDir,
        sessionId: context.sessionId,
        conversationId: context.conversationId,
        requestId: context.requestId,
        riskLevel,
        decision: 'error',
        durationMs,
        errorMessage: 'Cancelled',
        isExpected: true,
        errorCategory: 'tool_failure',
      });
      return { allowed: false, result: { content: 'Cancelled', isError: true } };
    }

    // Reject tools blocked by parental control settings before any permission check.
    if (isToolBlocked(name)) {
      log.warn(
        {
          toolName: name,
          sessionId: context.sessionId,
          conversationId: context.conversationId,
          principal: context.principal,
          reason: 'blocked_by_parental_controls',
        },
        'Parental control blocked tool invocation',
      );
      const durationMs = Date.now() - startTime;
      emitLifecycleEvent({
        type: 'permission_denied',
        toolName: name,
        executionTarget,
        input,
        workingDir: context.workingDir,
        sessionId: context.sessionId,
        conversationId: context.conversationId,
        requestId: context.requestId,
        riskLevel,
        decision: 'deny',
        reason: 'Blocked by parental control settings',
        durationMs,
      });
      return { allowed: false, result: { content: 'This tool is blocked by parental control settings.', isError: true } };
    }

    // Reject tool invocations targeting guardian control-plane endpoints from non-guardian actors.
    const guardianCheck = enforceGuardianOnlyPolicy(name, input, context.guardianActorRole);
    if (guardianCheck.denied) {
      log.warn({
        toolName: name,
        sessionId: context.sessionId,
        conversationId: context.conversationId,
        actorRole: context.guardianActorRole,
        reason: 'guardian_only_policy',
      }, 'Guardian-only policy blocked tool invocation');
      const durationMs = Date.now() - startTime;
      emitLifecycleEvent({
        type: 'permission_denied',
        toolName: name,
        executionTarget,
        input,
        workingDir: context.workingDir,
        sessionId: context.sessionId,
        conversationId: context.conversationId,
        requestId: context.requestId,
        riskLevel,
        decision: 'deny',
        reason: guardianCheck.reason!,
        durationMs,
      });
      return { allowed: false, result: { content: guardianCheck.reason!, isError: true } };
    }

    // Determine whether this invocation requires a scoped grant. Capture
    // the consume params now but defer the actual atomic consumption until
    // after all downstream policy gates (allowedToolNames, task-run
    // preflight, tool registry) pass. This prevents wasting a one-time-use
    // grant when a subsequent gate rejects the invocation.
    let needsGrantConsumption = false;
    let deferredConsumeParams: Parameters<typeof consumeGrantForInvocation>[0] | null = null;

    if (
      isUntrustedGuardianActorRole(context.guardianActorRole)
      && requiresGuardianApprovalForActor(name, input, executionTarget)
    ) {
      const inputDigest = computeToolApprovalDigest(name, input);
      needsGrantConsumption = true;
      deferredConsumeParams = {
        requestId: context.requestId,
        toolName: name,
        inputDigest,
        consumingRequestId: context.requestId ?? `preexec-${context.sessionId}-${Date.now()}`,
        assistantId: context.assistantId ?? 'self',
        executionChannel: context.executionChannel,
        conversationId: context.conversationId,
        callSessionId: context.callSessionId,
        requesterExternalUserId: context.requesterExternalUserId,
      };
    }

    // Gate tools not active for the current turn
    if (context.allowedToolNames && !context.allowedToolNames.has(name)) {
      const msg = `Tool "${name}" is not currently active. Load the skill that provides this tool first.`;
      const durationMs = Date.now() - startTime;
      emitLifecycleEvent({
        type: 'error',
        toolName: name,
        executionTarget,
        input,
        workingDir: context.workingDir,
        sessionId: context.sessionId,
        conversationId: context.conversationId,
        requestId: context.requestId,
        riskLevel,
        decision: 'error',
        durationMs,
        errorMessage: msg,
        isExpected: true,
        errorCategory: 'tool_failure',
      });
      return { allowed: false, result: { content: msg, isError: true } };
    }

    // Belt-and-suspenders guard for task runs: only preflight-approved tools
    // may execute. This catches cases where ephemeral rules might not cover
    // a tool, ensuring unapproved calls fail deterministically instead of
    // falling through to the interactive prompter.
    if (context.taskRunId) {
      const taskRules = getTaskRunRules(context.taskRunId);
      const approvedToolNames = new Set(taskRules.map((r) => r.tool));
      if (approvedToolNames.size > 0 && !approvedToolNames.has(name)) {
        const msg = `Tool '${name}' was not approved in the task's preflight. Add it to required tools and re-approve.`;
        const durationMs = Date.now() - startTime;
        emitLifecycleEvent({
          type: 'permission_denied',
          toolName: name,
          executionTarget,
          input,
          workingDir: context.workingDir,
          sessionId: context.sessionId,
          conversationId: context.conversationId,
          requestId: context.requestId,
          riskLevel,
          decision: 'deny',
          reason: msg,
          durationMs,
        });
        return { allowed: false, result: { content: msg, isError: true } };
      }
    }

    // Resolve the tool from the registry
    const tool = getTool(name);
    if (!tool) {
      const available = getAllTools().filter((t) => t.executionMode !== 'proxy' || context.proxyToolResolver).map((t) => t.name).sort().join(', ');
      const msg = `Unknown tool: ${name}. Available tools: ${available}`;
      const durationMs = Date.now() - startTime;
      emitLifecycleEvent({
        type: 'error',
        toolName: name,
        executionTarget,
        input,
        workingDir: context.workingDir,
        sessionId: context.sessionId,
        conversationId: context.conversationId,
        requestId: context.requestId,
        riskLevel,
        decision: 'error',
        durationMs,
        errorMessage: msg,
        isExpected: true,
        errorCategory: 'tool_failure',
      });
      return { allowed: false, result: { content: msg, isError: true } };
    }

    // All policy gates passed. Now consume the scoped grant if one is
    // required. Deferring consumption to this point ensures a downstream
    // rejection (allowedToolNames, task-run preflight, registry lookup)
    // does not waste the one-time-use grant.
    if (needsGrantConsumption && deferredConsumeParams) {
      const grantResult = await consumeGrantForInvocation(deferredConsumeParams);

      if (grantResult.ok) {
        log.info({
          toolName: name,
          sessionId: context.sessionId,
          conversationId: context.conversationId,
          actorRole: context.guardianActorRole,
          executionTarget,
          grantId: grantResult.grant.id,
        }, 'Scoped grant consumed — allowing untrusted actor tool invocation');

        return { allowed: true, tool, grantConsumed: true };
      }

      // No matching grant or race condition — deny.
      const reason = guardianApprovalDeniedMessage(context.guardianActorRole, name);
      log.warn({
        toolName: name,
        sessionId: context.sessionId,
        conversationId: context.conversationId,
        actorRole: context.guardianActorRole,
        executionTarget,
        reason: 'guardian_approval_required',
        grantMissReason: grantResult.reason,
      }, 'Guardian approval gate blocked untrusted actor tool invocation (no matching grant)');
      const durationMs = Date.now() - startTime;
      emitLifecycleEvent({
        type: 'permission_denied',
        toolName: name,
        executionTarget,
        input,
        workingDir: context.workingDir,
        sessionId: context.sessionId,
        conversationId: context.conversationId,
        requestId: context.requestId,
        riskLevel,
        decision: 'deny',
        reason,
        durationMs,
      });
      return { allowed: false, result: { content: reason, isError: true } };
    }

    return { allowed: true, tool };
  }
}
