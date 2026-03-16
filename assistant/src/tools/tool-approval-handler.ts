import { consumeGrantForInvocation } from "../approvals/approval-primitive.js";
import { isToolAllowedInChannel } from "../channels/permission-profiles.js";
import {
  getCanonicalGuardianRequest,
  updateCanonicalGuardianRequest,
} from "../memory/canonical-guardian-store.js";
import { isUntrustedTrustClass } from "../runtime/actor-trust-resolver.js";
import { createOrReuseToolGrantRequest } from "../runtime/tool-grant-request-helper.js";
import { computeToolApprovalDigest } from "../security/tool-approval-digest.js";
import { getTaskRunRules } from "../tasks/ephemeral-permissions.js";
import { getLogger } from "../util/logger.js";
import { getAllTools, getTool } from "./registry.js";
import { isSideEffectTool } from "./side-effects.js";
import type {
  ExecutionTarget,
  Tool,
  ToolContext,
  ToolExecutionResult,
  ToolLifecycleEvent,
} from "./types.js";
import { enforceVerificationControlPlanePolicy } from "./verification-control-plane-policy.js";

const log = getLogger("tool-approval-handler");

/** Default polling interval for inline grant wait (ms). */
export const TC_GRANT_WAIT_INTERVAL_MS = 500;
/** Default maximum wait time for inline grant wait (ms). */
export const TC_GRANT_WAIT_MAX_MS = 60_000;

/**
 * Inline wait result for trusted-contact grant polling.
 * - `granted`: a grant was minted and consumed within the wait window.
 * - `denied`: the guardian explicitly rejected the request.
 * - `timeout`: the wait budget expired without a decision.
 * - `aborted`: the session was cancelled during the wait.
 * - `escalation_failed`: the grant request could not be created.
 */
export type InlineGrantWaitOutcome =
  | { outcome: "granted"; grant: { id: string } }
  | { outcome: "denied"; requestId: string }
  | { outcome: "timeout"; requestId: string }
  | { outcome: "aborted" }
  | { outcome: "escalation_failed"; reason: string };

/**
 * Wait bounded for a guardian to approve a tool grant request and for the
 * resulting grant to become consumable. Polls both the canonical request
 * status (to detect early rejection) and the grant store (to detect approval
 * and atomically consume the grant).
 *
 * Only called for trusted_contact actors with valid guardian bindings.
 */
export async function waitForInlineGrant(
  escalationRequestId: string,
  consumeParams: Parameters<typeof consumeGrantForInvocation>[0],
  options?: { maxWaitMs?: number; intervalMs?: number; signal?: AbortSignal },
): Promise<InlineGrantWaitOutcome> {
  const maxWait = options?.maxWaitMs ?? TC_GRANT_WAIT_MAX_MS;
  const interval = options?.intervalMs ?? TC_GRANT_WAIT_INTERVAL_MS;
  const signal = options?.signal;
  const deadline = Date.now() + maxWait;

  log.info(
    {
      event: "tc_inline_grant_wait_start",
      escalationRequestId,
      toolName: consumeParams.toolName,
      maxWaitMs: maxWait,
      intervalMs: interval,
    },
    "Starting inline wait for guardian grant decision",
  );

  while (Date.now() < deadline) {
    if (signal?.aborted) {
      return { outcome: "aborted" };
    }

    await new Promise((resolve) => setTimeout(resolve, interval));

    if (signal?.aborted) {
      return { outcome: "aborted" };
    }

    // Check if the canonical request was rejected — exit early without
    // waiting for the full timeout.
    const request = getCanonicalGuardianRequest(escalationRequestId);
    if (request && request.status === "denied") {
      log.info(
        {
          event: "tc_inline_grant_wait_denied",
          escalationRequestId,
          toolName: consumeParams.toolName,
          elapsedMs: maxWait - (deadline - Date.now()),
        },
        "Guardian denied tool grant request during inline wait",
      );
      return { outcome: "denied", requestId: escalationRequestId };
    }

    // Try to consume the grant — if the guardian approved, the canonical
    // decision primitive will have minted a scoped grant by now.
    const grantResult = await consumeGrantForInvocation(consumeParams, {
      maxWaitMs: 0,
    });
    if (grantResult.ok) {
      log.info(
        {
          event: "tc_inline_grant_wait_granted",
          escalationRequestId,
          toolName: consumeParams.toolName,
          grantId: grantResult.grant.id,
          elapsedMs: maxWait - (deadline - Date.now()),
        },
        "Grant found during inline wait — tool execution proceeding",
      );
      return { outcome: "granted", grant: { id: grantResult.grant.id } };
    }
  }

  log.info(
    {
      event: "tc_inline_grant_wait_timeout",
      escalationRequestId,
      toolName: consumeParams.toolName,
      maxWaitMs: maxWait,
    },
    "Inline grant wait timed out — no guardian decision within budget",
  );
  return { outcome: "timeout", requestId: escalationRequestId };
}

function requiresGuardianApprovalForActor(
  toolName: string,
  input: Record<string, unknown>,
  executionTarget: ExecutionTarget,
): boolean {
  // Side-effect tools always require guardian approval for untrusted actors.
  // Read-only host execution is also blocked because it can leak sensitive
  // local information (e.g. shell/file reads).
  return isSideEffectTool(toolName, input) || executionTarget === "host";
}

function guardianApprovalDeniedMessage(
  trustClass: ToolContext["trustClass"],
  toolName: string,
): string {
  if (trustClass === "unknown") {
    return `Permission denied for "${toolName}": this action requires guardian approval from a verified channel identity.`;
  }
  return `Permission denied for "${toolName}": this action requires guardian approval and the current actor is not the guardian.`;
}

export type PreExecutionGateResult =
  | { allowed: true; tool: Tool; grantConsumed?: boolean }
  | { allowed: false; result: ToolExecutionResult };

/** Configuration for the inline grant wait behavior. */
export interface InlineGrantWaitConfig {
  /** Maximum time to wait for guardian approval (ms). Defaults to TC_GRANT_WAIT_MAX_MS. */
  maxWaitMs?: number;
  /** Polling interval during the wait (ms). Defaults to TC_GRANT_WAIT_INTERVAL_MS. */
  intervalMs?: number;
}

/**
 * Handles pre-execution approval gates: abort checks, guardian policy,
 * allowed-tool-set gating, and task-run preflight checks.
 * These run before the interactive permission prompt flow.
 */
export class ToolApprovalHandler {
  private inlineGrantWaitConfig: InlineGrantWaitConfig;

  constructor(config?: { inlineGrantWait?: InlineGrantWaitConfig }) {
    this.inlineGrantWaitConfig = config?.inlineGrantWait ?? {};
  }

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
        type: "error",
        toolName: name,
        executionTarget,
        input,
        workingDir: context.workingDir,
        conversationId: context.conversationId,
        requestId: context.requestId,
        riskLevel,
        decision: "error",
        durationMs,
        errorMessage: "Cancelled",
        isExpected: true,
        errorCategory: "tool_failure",
      });
      return {
        allowed: false,
        result: { content: "Cancelled", isError: true },
      };
    }

    // Reject tool invocations targeting guardian control-plane endpoints from non-guardian actors.
    const guardianCheck = enforceVerificationControlPlanePolicy(
      name,
      input,
      context.trustClass,
    );
    if (guardianCheck.denied) {
      log.warn(
        {
          toolName: name,
          conversationId: context.conversationId,
          trustClass: context.trustClass,
          reason: "guardian_only_policy",
        },
        "Guardian-only policy blocked tool invocation",
      );
      const durationMs = Date.now() - startTime;
      emitLifecycleEvent({
        type: "permission_denied",
        toolName: name,
        executionTarget,
        input,
        workingDir: context.workingDir,
        conversationId: context.conversationId,
        requestId: context.requestId,
        riskLevel,
        decision: "deny",
        reason: guardianCheck.reason!,
        durationMs,
      });
      return {
        allowed: false,
        result: { content: guardianCheck.reason!, isError: true },
      };
    }

    // Determine whether this invocation requires a scoped grant. Capture
    // the consume params now but defer the actual atomic consumption until
    // after all downstream policy gates (allowedToolNames, task-run
    // preflight, tool registry) pass. This prevents wasting a one-time-use
    // grant when a subsequent gate rejects the invocation.
    let needsGrantConsumption = false;
    let deferredConsumeParams:
      | Parameters<typeof consumeGrantForInvocation>[0]
      | null = null;

    if (
      isUntrustedTrustClass(context.trustClass) &&
      requiresGuardianApprovalForActor(name, input, executionTarget)
    ) {
      const inputDigest = computeToolApprovalDigest(name, input);
      needsGrantConsumption = true;
      deferredConsumeParams = {
        requestId: context.requestId,
        toolName: name,
        inputDigest,
        consumingRequestId:
          context.requestId ??
          `preexec-${context.conversationId}-${Date.now()}`,
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
        type: "error",
        toolName: name,
        executionTarget,
        input,
        workingDir: context.workingDir,
        conversationId: context.conversationId,
        requestId: context.requestId,
        riskLevel,
        decision: "error",
        durationMs,
        errorMessage: msg,
        isExpected: true,
        errorCategory: "tool_failure",
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
          type: "permission_denied",
          toolName: name,
          executionTarget,
          input,
          workingDir: context.workingDir,
          conversationId: context.conversationId,
          requestId: context.requestId,
          riskLevel,
          decision: "deny",
          reason: msg,
          durationMs,
        });
        return { allowed: false, result: { content: msg, isError: true } };
      }
    }

    // Resolve the tool from the registry
    const tool = getTool(name);
    if (!tool) {
      const available = getAllTools()
        .filter((t) => t.executionMode !== "proxy" || context.proxyToolResolver)
        .map((t) => t.name)
        .sort()
        .join(", ");
      const msg = `Unknown tool: ${name}. Available tools: ${available}`;
      const durationMs = Date.now() - startTime;
      emitLifecycleEvent({
        type: "error",
        toolName: name,
        executionTarget,
        input,
        workingDir: context.workingDir,
        conversationId: context.conversationId,
        requestId: context.requestId,
        riskLevel,
        decision: "error",
        durationMs,
        errorMessage: msg,
        isExpected: true,
        errorCategory: "tool_failure",
      });
      return { allowed: false, result: { content: msg, isError: true } };
    }

    // Enforce channel-scoped permission profiles (deterministic gate).
    // When the session originates from a Slack channel with a configured
    // permission profile, blocked tools and category restrictions are
    // enforced here rather than relying on model compliance with hints.
    if (
      context.executionChannel === "slack" &&
      context.channelPermissionChannelId
    ) {
      if (
        !isToolAllowedInChannel(
          context.channelPermissionChannelId,
          name,
          tool.category,
        )
      ) {
        const msg = `Tool "${name}" is not allowed in this channel per channel permission policy.`;
        log.warn(
          {
            toolName: name,
            channelId: context.channelPermissionChannelId,
            category: tool.category,
            conversationId: context.conversationId,
            reason: "channel_permission_policy",
          },
          "Channel permission policy blocked tool invocation",
        );
        const durationMs = Date.now() - startTime;
        emitLifecycleEvent({
          type: "permission_denied",
          toolName: name,
          executionTarget,
          input,
          workingDir: context.workingDir,
          conversationId: context.conversationId,
          requestId: context.requestId,
          riskLevel,
          decision: "deny",
          reason: msg,
          durationMs,
        });
        return { allowed: false, result: { content: msg, isError: true } };
      }
    }

    // All policy gates passed. Now consume the scoped grant if one is
    // required. Deferring consumption to this point ensures a downstream
    // rejection (allowedToolNames, task-run preflight, registry lookup)
    // does not waste the one-time-use grant.
    //
    // Retry polling is scoped to the voice channel where a race condition
    // exists between fire-and-forget turn execution and LLM fallback grant
    // minting (2-5s). Non-voice channels get an instant sync lookup so
    // normal denials are not delayed.
    if (needsGrantConsumption && deferredConsumeParams) {
      const isVoice = context.executionChannel === "phone";
      const grantResult = await consumeGrantForInvocation(
        deferredConsumeParams,
        isVoice ? { signal: context.signal } : { maxWaitMs: 0 },
      );

      if (grantResult.ok) {
        log.info(
          {
            toolName: name,
            conversationId: context.conversationId,
            trustClass: context.trustClass,
            executionTarget,
            grantId: grantResult.grant.id,
          },
          "Scoped grant consumed — allowing untrusted actor tool invocation",
        );

        return { allowed: true, tool, grantConsumed: true };
      }

      // Treat abort as a cancellation — not a grant denial. This matches
      // the abort check at the top of checkPreExecutionGates so the caller
      // sees a consistent "Cancelled" result instead of a spurious
      // guardian_approval_required denial during voice barge-in.
      if (grantResult.reason === "aborted") {
        const durationMs = Date.now() - startTime;
        emitLifecycleEvent({
          type: "error",
          toolName: name,
          executionTarget,
          input,
          workingDir: context.workingDir,
          conversationId: context.conversationId,
          requestId: context.requestId,
          riskLevel,
          decision: "error",
          durationMs,
          errorMessage: "Cancelled",
          isExpected: true,
          errorCategory: "tool_failure",
        });
        return {
          allowed: false,
          result: { content: "Cancelled", isError: true },
        };
      }

      // No matching grant or race condition — deny or wait inline.
      //
      // For verified non-guardian actors (trusted_contact) with sufficient
      // context, escalate to the guardian by creating a canonical
      // tool_grant_request. Then wait bounded for the grant to become
      // available — this lets the tool call succeed inline after guardian
      // approval without the requester having to retry manually.
      //
      // Unverified actors remain fail-closed with no escalation or wait.
      if (
        context.trustClass === "trusted_contact" &&
        context.assistantId &&
        context.executionChannel &&
        context.requesterExternalUserId
      ) {
        const inputDigest =
          deferredConsumeParams?.inputDigest ??
          computeToolApprovalDigest(name, input);
        const escalation = createOrReuseToolGrantRequest({
          assistantId: context.assistantId,
          sourceChannel:
            context.executionChannel as import("../channels/types.js").ChannelId,
          conversationId: context.conversationId,
          requesterExternalUserId: context.requesterExternalUserId,
          requesterChatId: context.requesterChatId,
          toolName: name,
          inputDigest,
          questionText: `Trusted contact is requesting permission to use "${name}"`,
        });

        // Only wait inline if the escalation succeeded (created or deduped).
        // If escalation failed (no binding, missing identity), fall through
        // to the generic denial path.
        if ("created" in escalation || "deduped" in escalation) {
          // Stamp the canonical request so the approval resolver knows an
          // inline consumer is waiting. Without this, the resolver would
          // send a stale "please retry" notification even though the
          // original invocation is about to resume inline.
          updateCanonicalGuardianRequest(escalation.requestId, {
            followupState: "inline_wait_active:" + Date.now(),
          });

          const waitResult = await waitForInlineGrant(
            escalation.requestId,
            deferredConsumeParams!,
            {
              maxWaitMs: this.inlineGrantWaitConfig.maxWaitMs,
              intervalMs: this.inlineGrantWaitConfig.intervalMs,
              signal: context.signal,
            },
          );

          if (waitResult.outcome === "granted") {
            // Clear the inline-wait stamp now that the grant has been consumed.
            updateCanonicalGuardianRequest(escalation.requestId, {
              followupState: null,
            });
            log.info(
              {
                toolName: name,
                conversationId: context.conversationId,
                trustClass: context.trustClass,
                executionTarget,
                grantId: waitResult.grant.id,
                escalationRequestId: escalation.requestId,
              },
              "Inline grant wait succeeded — allowing trusted contact tool invocation",
            );
            return { allowed: true, tool, grantConsumed: true };
          }

          if (waitResult.outcome === "aborted") {
            // Clear the inline-wait stamp so a later guardian approval
            // (if the request is still pending) will send the retry notification.
            updateCanonicalGuardianRequest(escalation.requestId, {
              followupState: null,
            });
            const durationMs = Date.now() - startTime;
            emitLifecycleEvent({
              type: "error",
              toolName: name,
              executionTarget,
              input,
              workingDir: context.workingDir,
              conversationId: context.conversationId,
              requestId: context.requestId,
              riskLevel,
              decision: "error",
              durationMs,
              errorMessage: "Cancelled",
              isExpected: true,
              errorCategory: "tool_failure",
            });
            return {
              allowed: false,
              result: { content: "Cancelled", isError: true },
            };
          }

          // Clear the inline-wait stamp so a later guardian approval
          // (if the request is still pending after timeout) will send
          // the retry notification as expected.
          updateCanonicalGuardianRequest(escalation.requestId, {
            followupState: null,
          });

          const codeSuffix = escalation.requestCode
            ? ` (request code: ${escalation.requestCode})`
            : "";

          let escalationMessage: string;
          if (waitResult.outcome === "denied") {
            escalationMessage = `Permission denied for "${name}": the guardian rejected the request${codeSuffix}.`;
          } else {
            // timeout
            escalationMessage =
              `Permission denied for "${name}": guardian approval was not received in time${codeSuffix}. ` +
              `Please retry after the guardian approves.`;
          }

          log.warn(
            {
              toolName: name,
              conversationId: context.conversationId,
              trustClass: context.trustClass,
              executionTarget,
              reason: "guardian_approval_required",
              grantMissReason: grantResult.reason,
              waitOutcome: waitResult.outcome,
              escalationRequestId: escalation.requestId,
            },
            "Inline grant wait ended without approval — denying trusted contact tool invocation",
          );
          const durationMs = Date.now() - startTime;
          emitLifecycleEvent({
            type: "permission_denied",
            toolName: name,
            executionTarget,
            input,
            workingDir: context.workingDir,
            conversationId: context.conversationId,
            requestId: context.requestId,
            riskLevel,
            decision: "deny",
            reason: escalationMessage,
            durationMs,
          });
          return {
            allowed: false,
            result: { content: escalationMessage, isError: true },
          };
        }
        // escalation.failed — fall through to generic denial.
      }

      // Unknown/unverified actors or escalation failures — generic denial.
      const reason = guardianApprovalDeniedMessage(context.trustClass, name);
      log.warn(
        {
          toolName: name,
          conversationId: context.conversationId,
          trustClass: context.trustClass,
          executionTarget,
          reason: "guardian_approval_required",
          grantMissReason: grantResult.reason,
          escalated: false,
        },
        "Guardian approval gate blocked untrusted actor tool invocation (no matching grant)",
      );
      const durationMs = Date.now() - startTime;
      emitLifecycleEvent({
        type: "permission_denied",
        toolName: name,
        executionTarget,
        input,
        workingDir: context.workingDir,
        conversationId: context.conversationId,
        requestId: context.requestId,
        riskLevel,
        decision: "deny",
        reason,
        durationMs,
      });
      return { allowed: false, result: { content: reason, isError: true } };
    }

    return { allowed: true, tool };
  }
}
