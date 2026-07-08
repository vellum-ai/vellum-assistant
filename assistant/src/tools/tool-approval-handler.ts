import { consumeGrantForInvocation } from "../approvals/approval-primitive.js";
import { isToolAllowedInChannel } from "../channels/permission-profiles.js";
import type { ChannelId } from "../channels/types.js";
import { getConfig } from "../config/loader.js";
import {
  getCanonicalGuardianRequest,
  updateCanonicalGuardianRequest,
} from "../contacts/canonical-guardian-store.js";
import type { AutoApproveThreshold } from "../permissions/approval-policy.js";
import {
  isUnparseableToolArgs,
  unparseableToolArgsMessage,
} from "../providers/unparseable-tool-args.js";
import {
  resolveCapabilities,
  type SensitiveToolApproval,
} from "../runtime/capabilities.js";
import { createOrReuseToolGrantRequest } from "../runtime/tool-grant-request-helper.js";
import { redactSecrets } from "../security/secret-scanner.js";
import { computeToolApprovalDigest } from "../security/tool-approval-digest.js";
import { recordToolDenied, recordToolError } from "../telemetry/tool-audit.js";
import { getLogger } from "../util/logger.js";
import { getAllTools, getTool, getToolOwner } from "./registry.js";
import { isSideEffectTool } from "./side-effects.js";
import { summarizeToolInput } from "./tool-input-summary.js";
import { suggestToolName } from "./tool-name-aliases.js";
import { recordToolCompletion } from "./tool-profiler.js";
import type { ExecutionTarget } from "./tool-types.js";
import {
  isDiskPressureCleanupToolName,
  type OwnerInfo,
  type Tool,
  type ToolContext,
  type ToolExecutionResult,
} from "./types.js";
import { enforceVerificationControlPlanePolicy } from "./verification-control-plane-policy.js";

const log = getLogger("tool-approval-handler");

/**
 * Compose the guardian-facing approval question. The question is about the
 * tool — phrased with the same `Approve tool:` pattern the
 * confirmation-request bridge uses — and the requester appears only as
 * parenthetical context, never as the subject of the decision.
 */
function buildToolGrantQuestionText(
  toolName: string,
  input: Record<string, unknown>,
  context: ToolContext,
): string {
  const requesterLabel =
    context.requesterDisplayName ||
    context.requesterIdentifier ||
    context.requesterExternalUserId;
  const requesterNote = requesterLabel
    ? ` (requested by ${requesterLabel})`
    : "";
  const inputSummary = redactSecrets(summarizeToolInput(toolName, input));
  const summaryPart = inputSummary ? ` — ${inputSummary}` : "";
  return `Approve tool: ${toolName}${summaryPart}${requesterNote}`;
}

/**
 * Compose the error message for a registered tool that is not part of the
 * current turn's active tool set, naming the gate that actually excluded it.
 * Ordered most-specific first:
 *
 * 1. Subagent allowlist — loading a skill cannot widen a subagent's
 *    allowlist, so this outranks the skill hint.
 * 2. Skill-owned tool whose skill is not loaded — the one case where
 *    "load the skill" is the correct instruction.
 * 3. Plugin-owned tool filtered by plugin enablement.
 * 4. `remember` while memory is disabled.
 * 5. Context gating (no connected client, channel capabilities, …) — no
 *    load hint; list the active tools so the model can re-plan with what
 *    actually exists this turn.
 */
export function buildInactiveToolMessage(args: {
  name: string;
  owner: OwnerInfo | undefined;
  subagentAllowedTools: ReadonlySet<string> | undefined;
  memoryEnabled: boolean;
  activeToolNames: ReadonlySet<string>;
}): string {
  const { name, owner, subagentAllowedTools, memoryEnabled, activeToolNames } =
    args;
  if (subagentAllowedTools && !subagentAllowedTools.has(name)) {
    const allowed = [...subagentAllowedTools].sort().join(", ");
    return `Tool "${name}" is not available to this subagent. This subagent may only use: ${allowed}.`;
  }
  if (owner?.kind === "skill") {
    return `Tool "${name}" is not currently active. Load the "${owner.id}" skill that provides this tool first.`;
  }
  if (owner?.kind === "plugin") {
    return `Tool "${name}" belongs to the "${owner.id}" plugin, which is not enabled for this conversation.`;
  }
  if (name === "remember" && !memoryEnabled) {
    return `Tool "remember" is unavailable because memory is disabled for this assistant.`;
  }
  if (activeToolNames.size === 0) {
    return `Tool "${name}" is not available in this context. No tools are active this turn.`;
  }
  const available = [...activeToolNames].sort().join(", ");
  return `Tool "${name}" is not available in this context. Available tools: ${available}`;
}

/** Default polling interval for inline grant wait (ms). */
const TC_GRANT_WAIT_INTERVAL_MS = 500;
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

    // Check if the canonical request was rejected - exit early without
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

    // Try to consume the grant - if the guardian approved, the canonical
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
        "Grant found during inline wait - tool execution proceeding",
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
    "Inline grant wait timed out - no guardian decision within budget",
  );
  return { outcome: "timeout", requestId: escalationRequestId };
}

const UI_SURFACE_TOOLS = new Set(["ui_show", "ui_update", "ui_dismiss"]);

/**
 * Tool-sensitivity predicate: does invoking this tool require an approval
 * decision at all? This is purely about the tool and where it executes —
 * actor identity never feeds in here (it enters the decision only through
 * the `CapabilitySet` floor, see {@link resolveSensitiveToolDecision}).
 */
export function isSensitiveTool(
  toolName: string,
  executionTarget: ExecutionTarget,
): boolean {
  // UI surface tools are passive, user-visible operations (cards, forms,
  // tables). User input is voluntary and user-controlled — they are not
  // sensitive, so they work during fresh onboarding before trust is
  // established.
  if (UI_SURFACE_TOOLS.has(toolName)) {
    return false;
  }

  // Side-effect tools are sensitive. Read-only host execution is too,
  // because it can leak sensitive local information (e.g. shell/file reads).
  return isSideEffectTool(toolName) || executionTarget === "host";
}

/**
 * Threshold for the approval cell governing an invocation — the matrix axis
 * of the sensitive-tool composition. Shares the auto-approve threshold
 * vocabulary defined in `permissions/approval-policy.ts`.
 */
export type ApprovalCellThreshold = AutoApproveThreshold;

/**
 * Outcome of the sensitive-tool composition:
 * - `proceed`: no scoped grant needed (tool not sensitive, or the actor's
 *   capability set self-approves; lane-B risk/threshold policy in
 *   `permissions/approval-policy.ts` still applies downstream).
 * - `escalate-and-wait`: a scoped grant is required; on a grant miss,
 *   escalate to the guardian and wait inline.
 * - `deny`: a scoped grant is required; on a grant miss, fail closed.
 */
export type SensitiveToolDecision = "proceed" | "escalate-and-wait" | "deny";

/**
 * Single composition point for the sensitive-tool approval decision:
 * approval-cell threshold × tool risk level × `CapabilitySet` floor.
 *
 * The decision is about the tool; actor identity feeds in only through the
 * already-resolved `sensitiveToolApproval` capability. That floor is
 * deterministic and cannot be lifted by the other axes: when the capability
 * is not `"self"`, a sensitive invocation without a grant always escalates
 * or denies. `cellThreshold` and `riskLevel` are composition axes the
 * decision does not consult — no threshold/risk combination may lift the
 * outcome above the floor.
 */
export function resolveSensitiveToolDecision(input: {
  sensitive: boolean;
  /**
   * Approval-matrix cell axis. The decision does not consult it — the floor
   * alone resolves the outcome — so callers pass `undefined` rather than
   * paying a threshold lookup to populate it.
   */
  cellThreshold: ApprovalCellThreshold | undefined;
  /**
   * Risk level as known at gate time. The full risk classification runs
   * after this gate (in the permission checker), so callers may only have
   * the pre-classification level here — composing decisions on this axis
   * requires moving classification ahead of the gate first.
   */
  riskLevel: string;
  sensitiveToolApproval: SensitiveToolApproval;
}): SensitiveToolDecision {
  if (!input.sensitive || input.sensitiveToolApproval === "self") {
    return "proceed";
  }
  return input.sensitiveToolApproval;
}

/**
 * Denial copy is about the tool (an action requiring guardian approval),
 * never about who the requester is.
 */
function sensitiveToolDeniedMessage(
  decision: SensitiveToolDecision,
  toolName: string,
): string {
  if (decision === "deny") {
    return `Permission denied for "${toolName}": this action requires guardian approval from a verified channel identity.`;
  }
  return `Permission denied for "${toolName}": this action requires guardian approval before it can run.`;
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
  /**
   * Audit a gate that failed the invocation with an error (never executed).
   * All pre-execution gate errors are anticipated control flow (abort, unknown
   * tool, disk pressure, unparseable args), so they audit as expected failures.
   */
  private auditGateError(
    context: ToolContext,
    name: string,
    input: Record<string, unknown>,
    riskLevel: string,
    startTime: number,
    errorMessage: string,
  ): void {
    const durationMs = Date.now() - startTime;
    recordToolError({
      conversationId: context.conversationId,
      requestId: context.requestId,
      toolName: name,
      input,
      errorMessage,
      isExpected: true,
      riskLevel,
      durationMs,
      attribution: context.attribution ?? null,
    });
    recordToolCompletion(context.conversationId, name, durationMs, true);
  }

  /** Audit a gate that blocked the invocation (deterministic, no user prompt). */
  private auditGateDenied(
    context: ToolContext,
    name: string,
    input: Record<string, unknown>,
    riskLevel: string,
    startTime: number,
    reason: string,
  ): void {
    recordToolDenied({
      conversationId: context.conversationId,
      toolName: name,
      input,
      reason,
      riskLevel,
      durationMs: Date.now() - startTime,
      wasPrompted: false,
    });
  }

  async checkPreExecutionGates(
    name: string,
    input: Record<string, unknown>,
    context: ToolContext,
    executionTarget: ExecutionTarget,
    riskLevel: string,
    startTime: number,
  ): Promise<PreExecutionGateResult> {
    // Bail out immediately if the session was aborted before this tool started.
    if (context.signal?.aborted) {
      this.auditGateError(
        context,
        name,
        input,
        riskLevel,
        startTime,
        "Cancelled",
      );
      return {
        allowed: false,
        result: { content: "Cancelled", isError: true },
      };
    }

    // Reject tool calls whose arguments failed JSON parsing in the provider
    // layer (wrapped under the `_raw` marker). Executing with the marker
    // object would feed garbage input to the tool — and worse, a tool that
    // tolerates missing fields can "succeed" (e.g. ui_show creating a
    // typeless surface), so the model never learns its arguments were
    // mangled. Fail loudly instead so the model retries.
    if (isUnparseableToolArgs(input)) {
      const msg = unparseableToolArgsMessage(name, input._raw);
      this.auditGateError(context, name, input, riskLevel, startTime, msg);
      return { allowed: false, result: { content: msg, isError: true } };
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
      this.auditGateDenied(
        context,
        name,
        input,
        riskLevel,
        startTime,
        guardianCheck.reason!,
      );
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

    const sensitive = isSensitiveTool(name, executionTarget);
    const { sensitiveToolApproval } = resolveCapabilities(context.trustClass);
    // cellThreshold stays unresolved: the decision does not consult it
    // (the floor is deterministic), and resolving a live threshold here
    // would block grant consumption — including already-approved calls and
    // voice abort handling — on a gateway IPC read.
    const sensitiveDecision = resolveSensitiveToolDecision({
      sensitive,
      cellThreshold: undefined,
      riskLevel,
      sensitiveToolApproval,
    });

    if (sensitiveDecision !== "proceed") {
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

    if (
      context.diskPressureCleanupModeActive === true &&
      !isDiskPressureCleanupToolName(name)
    ) {
      const msg = `Tool "${name}" is not available during disk pressure cleanup mode.`;
      this.auditGateError(context, name, input, riskLevel, startTime, msg);
      return { allowed: false, result: { content: msg, isError: true } };
    }

    // Look up the tool before the allowedToolNames gate so a name no skill
    // provides surfaces as "Unknown tool" (with the real list) instead of
    // the misleading "load the skill" hint.
    const tool = getTool(name);
    if (!tool) {
      const allowedToolNames = context.allowedToolNames;
      // List every registered tool. Tools that need an external resolver
      // (computer-use, ui-surface, etc.) now return a structured error
      // from their `execute()` when no resolver is connected, rather than
      // being filtered out here — listing them surfaces a clearer path
      // than hiding their names entirely.
      const availableNames = getAllTools()
        .map((t) => t.name)
        .filter((n) => !allowedToolNames || allowedToolNames.has(n))
        .sort();
      const suggestion = suggestToolName(name, availableNames);
      const didYouMean = suggestion ? ` Did you mean "${suggestion}"?` : "";
      const msg = `Unknown tool: ${name}.${didYouMean} Available tools: ${availableNames.join(", ")}`;
      this.auditGateError(context, name, input, riskLevel, startTime, msg);
      return { allowed: false, result: { content: msg, isError: true } };
    }

    // Gate tools not active for the current turn
    if (context.allowedToolNames && !context.allowedToolNames.has(name)) {
      let memoryEnabled = true;
      try {
        memoryEnabled = getConfig().memory?.enabled !== false;
      } catch {
        // Config unavailable — leave the memory hint out rather than guess.
      }
      const msg = buildInactiveToolMessage({
        name,
        owner: getToolOwner(name),
        subagentAllowedTools: context.subagentAllowedTools,
        memoryEnabled,
        activeToolNames: context.allowedToolNames,
      });
      this.auditGateError(context, name, input, riskLevel, startTime, msg);
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
        this.auditGateDenied(context, name, input, riskLevel, startTime, msg);
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
          "Scoped grant consumed - allowing untrusted actor tool invocation",
        );

        return { allowed: true, tool, grantConsumed: true };
      }

      // Treat abort as a cancellation - not a grant denial. This matches
      // the abort check at the top of checkPreExecutionGates so the caller
      // sees a consistent "Cancelled" result instead of a spurious
      // guardian_approval_required denial during voice barge-in.
      if (grantResult.reason === "aborted") {
        this.auditGateError(
          context,
          name,
          input,
          riskLevel,
          startTime,
          "Cancelled",
        );
        return {
          allowed: false,
          result: { content: "Cancelled", isError: true },
        };
      }

      // No matching grant or race condition - deny or wait inline.
      //
      // For non-guardian actors with established identity (trusted_contact
      // or unverified_contact) and sufficient context, escalate to the
      // guardian by creating a canonical tool_grant_request. Then wait
      // bounded for the grant to become available - this lets the tool call
      // succeed inline after guardian approval without the requester having
      // to retry manually.
      //
      // Actors with no identity (unknown) remain fail-closed with no
      // escalation or wait.
      if (
        sensitiveDecision === "escalate-and-wait" &&
        context.assistantId &&
        context.executionChannel &&
        context.requesterExternalUserId
      ) {
        const inputDigest =
          deferredConsumeParams?.inputDigest ??
          computeToolApprovalDigest(name, input);
        const escalation = await createOrReuseToolGrantRequest({
          assistantId: context.assistantId,
          sourceChannel: context.executionChannel as ChannelId,
          conversationId: context.conversationId,
          requesterExternalUserId: context.requesterExternalUserId,
          requesterChatId: context.requesterChatId,
          toolName: name,
          inputDigest,
          questionText: buildToolGrantQuestionText(name, input, context),
          requesterIdentifier:
            context.requesterDisplayName || context.requesterIdentifier,
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
              "Inline grant wait succeeded - allowing trusted contact tool invocation",
            );
            return { allowed: true, tool, grantConsumed: true };
          }

          if (waitResult.outcome === "aborted") {
            // Clear the inline-wait stamp so a later guardian approval
            // (if the request is still pending) will send the retry notification.
            updateCanonicalGuardianRequest(escalation.requestId, {
              followupState: null,
            });
            this.auditGateError(
              context,
              name,
              input,
              riskLevel,
              startTime,
              "Cancelled",
            );
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
            "Inline grant wait ended without approval - denying trusted contact tool invocation",
          );
          this.auditGateDenied(
            context,
            name,
            input,
            riskLevel,
            startTime,
            escalationMessage,
          );
          return {
            allowed: false,
            result: { content: escalationMessage, isError: true },
          };
        }
        // escalation.failed - fall through to generic denial.
      }

      // Unknown/unverified actors or escalation failures - generic denial.
      const reason = sensitiveToolDeniedMessage(sensitiveDecision, name);
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
      this.auditGateDenied(context, name, input, riskLevel, startTime, reason);
      return { allowed: false, result: { content: reason, isError: true } };
    }

    return { allowed: true, tool };
  }
}
