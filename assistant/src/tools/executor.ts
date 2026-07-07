import { readFileSync } from "node:fs";

import { getConfig } from "../config/loader.js";
import { bridgeCesApproval } from "../credential-execution/approval-bridge.js";
import { isCesShellLockdownEnabled } from "../credential-execution/feature-gates.js";
import { PermissionPrompter } from "../permissions/prompter.js";
import { RiskLevel } from "../permissions/types.js";
import { isUntrustedShellLockdownActive } from "../runtime/effective-capabilities.js";
import { redactSensitiveFields } from "../security/redaction.js";
import { getCesClient } from "../security/secure-keys.js";
import { TokenExpiredError } from "../security/token-manager.js";
import { type AbortReason, isAbortReason } from "../util/abort-reasons.js";
import { PermissionDeniedError, ToolError } from "../util/errors.js";
import { pathExists, safeStatSync } from "../util/fs.js";
import { getLogger, truncateForLog } from "../util/logger.js";
import {
  callerOwnsWorkflowRun,
  manifestGrantsSideEffects,
} from "../workflows/capabilities.js";
import { getWorkflowRunManager } from "../workflows/run-manager.js";
import { resolveExecutionTarget } from "./execution-target.js";
import { executeWithTimeout, safeTimeoutMs } from "./execution-timeout.js";
import { PermissionChecker } from "./permission-checker.js";
import { extractAndSanitize } from "./sensitive-output-placeholders.js";
import { applyEdit } from "./shared/filesystem/edit-engine.js";
import { sandboxPolicy } from "./shared/filesystem/path-policy.js";
import { MAX_FILE_SIZE_BYTES } from "./shared/filesystem/size-guard.js";
import { ToolApprovalHandler } from "./tool-approval-handler.js";
import { resolveToolInvocationAlias } from "./tool-name-aliases.js";
import {
  stringifyToolInput,
  type ToolContext,
  type ToolExecutionResult,
  type ToolLifecycleEvent,
} from "./types.js";

const log = getLogger("tool-executor");

export class ToolExecutor {
  private prompter: PermissionPrompter;
  private permissionChecker: PermissionChecker;
  private approvalHandler: ToolApprovalHandler;

  constructor(prompter: PermissionPrompter) {
    this.prompter = prompter;
    this.permissionChecker = new PermissionChecker(prompter);
    this.approvalHandler = new ToolApprovalHandler();
  }

  async execute(
    name: string,
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    const { name: executionName, input: executionInput } =
      resolveToolInvocationAlias(name, input, context.allowedToolNames);
    return this.executeInternal(executionName, executionInput, context);
  }

  private async executeInternal(
    name: string,
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    const startTime = Date.now();
    let decision = "allow";
    let riskLevel: string = RiskLevel.Low;
    let permRiskMeta:
      | {
          riskLevel: string;
          riskReason: string;
          riskScopeOptions: Array<{ pattern: string; label: string }>;
          riskAllowlistOptions?: Array<{
            label: string;
            description: string;
            pattern: string;
          }>;
          riskDirectoryScopeOptions?: Array<{ scope: string; label: string }>;
          isContainerized?: boolean;
        }
      | undefined;
    let permMatchedTrustRuleId: string | undefined;
    let permApprovalMode: string | undefined;
    let permApprovalReason: string | undefined;
    let permRiskThreshold: string | undefined;
    // The dispatcher stamps `executionTarget` from the tool as presented to the
    // model this turn (see conversation-tool-setup), so routing can't drift if
    // the registry entry for this name is swapped mid-turn. The
    // `resolveExecutionTarget` fallback covers callers with no snapshot (e.g.
    // standalone runs).
    const executionTarget =
      context.executionTarget ?? resolveExecutionTarget({ name });

    emitLifecycleEvent(context, {
      type: "start",
      toolName: name,
      executionTarget,
      input,
      workingDir: context.workingDir,
      conversationId: context.conversationId,
      requestId: context.requestId,
      startedAtMs: startTime,
    });

    // Run pre-execution approval gates (abort, guardian policy,
    // allowed-tool-set, task-run preflight, tool registry lookup).
    const gateResult = await this.approvalHandler.checkPreExecutionGates(
      name,
      input,
      context,
      executionTarget,
      riskLevel,
      startTime,
      (event) => emitLifecycleEvent(context, event),
    );

    if (!gateResult.allowed) {
      return gateResult.result;
    }

    const tool = gateResult.tool;

    try {
      // CES shell lockdown: set forcePromptSideEffects BEFORE both the
      // grantConsumed short-circuit and the permission check. This ensures
      // the flag is visible to all downstream consumers regardless of
      // whether a scoped grant was consumed. Previously this was nested
      // inside the `!grantConsumed` block, meaning untrusted host_bash
      // calls that arrived with a consumed guardian-approval grant would
      // skip this assignment entirely - defeating the lockdown.
      if (
        name === "host_bash" &&
        isUntrustedShellLockdownActive({
          trustClass: context.trustClass,
          lockdownEnabled: isCesShellLockdownEnabled(getConfig()),
        })
      ) {
        context.forcePromptSideEffects = true;
      }

      // Secure command tool installation always requires fresh per-invocation
      // approval - no persistent grants. This is unconditional (not gated on
      // CES lockdown or trust class) because installing secure tools is
      // inherently high-impact.
      if (name === "manage_secure_command_tool") {
        context.forcePromptSideEffects = true;
        context.requireFreshApproval = true;
      }

      // A workflow run whose capability manifest grants side-effecting tools or
      // host functions (beyond the read-only baseline) must prompt at LAUNCH.
      // The manifest is authored and declared by the model, and the run's
      // leaves execute granted tools DIRECTLY (no per-call permission check) -
      // so the launch is the single point at which the user can consent to the
      // grant, which would otherwise bypass the gate those tools hit when the
      // main agent calls them. requireFreshApproval promotes the otherwise
      // low-risk launch to an interactive prompt that cached grants/trust rules
      // cannot silently bypass (run_workflow is not itself a SIDE_EFFECT tool,
      // so forcePromptSideEffects would not fire — requireFreshApproval is the
      // self-sufficient promotion). Read-only runs stay low-risk and silent.
      if (
        name === "run_workflow" &&
        manifestGrantsSideEffects(input.capabilities)
      ) {
        context.requireFreshApproval = true;
      }

      // Creating a workflow-mode schedule whose capability manifest grants
      // side-effecting tools or host functions persists that grant for an
      // unattended future run — so the user consents to it at CREATION, the
      // single interactive point in the flow (a triggered run later fires with
      // no live conversation). Same rationale as run_workflow above: the
      // manifest is model-declared and the eventual run's leaves execute granted
      // tools directly (no per-call prompt). Read-only or absent manifests stay
      // low-risk and silent. `schedule_create` is not a SIDE_EFFECT tool, so
      // requireFreshApproval is the self-sufficient promotion.
      if (
        name === "schedule_create" &&
        input.mode === "workflow" &&
        manifestGrantsSideEffects(input.capabilities)
      ) {
        context.requireFreshApproval = true;
      }

      // Resuming a workflow whose STORED manifest granted side-effecting tools /
      // host functions restarts unfinished leaves that perform those side
      // effects. The original consent was given at LAUNCH (run_workflow above),
      // but resume is reachable by any actor who can list or guess the run id —
      // so re-require a fresh interactive approval when the target run's stored
      // manifest grants side effects. The other manage_workflows actions
      // (status/abort/list_runs) and resumes of read-only runs stay low-risk and
      // silent. `manage_workflows` is not a SIDE_EFFECT tool, so (like
      // run_workflow) requireFreshApproval is the self-sufficient promotion.
      if (name === "manage_workflows" && input.action === "resume") {
        const targetRunId =
          typeof input.run_id === "string" ? input.run_id : undefined;
        const targetRun = targetRunId
          ? getWorkflowRunManager().status(targetRunId)
          : null;
        // Only promote to fresh approval for a run the caller actually OWNS. The
        // tool hides others' runs as not-found, so prompting here for a
        // non-owned run would both leak that the run exists and nag the guardian
        // for a resume that will return not-found. Uses the same ownership scope
        // the tool applies (callerOwnsWorkflowRun) so the gate and the tool agree.
        if (
          targetRun &&
          callerOwnsWorkflowRun(targetRun, context) &&
          manifestGrantsSideEffects(targetRun.capabilities)
        ) {
          context.requireFreshApproval = true;
        }
      }

      // A consumed scoped grant is a complete authorization - skip the
      // interactive permission/prompt flow so non-interactive sessions
      // don't auto-deny prompt-gated tools and burn the one-time grant.
      // Exception: requireFreshApproval tools always go through the
      // permission check even when a grant was consumed - the grant does
      // not substitute for an interactive human review.
      if (!gateResult.grantConsumed || context.requireFreshApproval) {
        // Check permissions via the extracted PermissionChecker
        const permResult = await this.permissionChecker.checkPermission(
          name,
          input,
          tool,
          context,
          executionTarget,
          (event) => emitLifecycleEvent(context, event),
          startTime,
          computePreviewDiff,
        );

        riskLevel = permResult.riskLevel;
        decision = permResult.decision;
        permRiskMeta = permResult.riskMeta;
        permMatchedTrustRuleId = permResult.matchedTrustRuleId;
        permApprovalMode = permResult.approvalMode;
        permApprovalReason = permResult.approvalReason;
        permRiskThreshold = permResult.riskThreshold;

        if (!permResult.allowed) {
          return {
            content: permResult.content,
            isError: true,
            riskLevel: permRiskMeta?.riskLevel,
            riskReason: permRiskMeta?.riskReason,
            riskScopeOptions: permRiskMeta?.riskScopeOptions,
            riskAllowlistOptions: permRiskMeta?.riskAllowlistOptions,
            riskDirectoryScopeOptions: permRiskMeta?.riskDirectoryScopeOptions,
            isContainerized: permRiskMeta?.isContainerized,
            matchedTrustRuleId: permMatchedTrustRuleId,
            approvalMode: permApprovalMode,
            approvalReason: permApprovalReason,
            riskThreshold: permRiskThreshold,
          };
        }

        if (permResult.wasPrompted) {
          context.approvedViaPrompt = true;
        }
      } else {
        // Grant consumed — permission check was skipped. Set provenance explicitly
        // so the record shows how this execution was authorized.
        permApprovalMode = "auto";
        permApprovalReason = "grant_scoped_consumed";
      }

      // Execute the tool. Tools that forward to an external resolver
      // (computer-use, ui-surface, apps, meet) handle that dispatch in
      // their own `execute()` body — the executor no longer special-cases
      // proxy mode here.
      const toolTimeoutMs = computePerToolTimeoutMs(name, input);
      const execContext = context;

      let execResult: ToolExecutionResult = await executeWithTimeout(
        tool.execute(input, execContext),
        toolTimeoutMs,
        name,
      );

      // CES approval bridge: if the tool returned an approval_required
      // indicator, present the proposal to the guardian via the existing
      // confirmation transport, commit the decision to CES, and retry
      // the original tool invocation with the granted grantId.
      const cesClient = getCesClient();
      if (execResult.cesApprovalRequired && !cesClient) {
        const msg = `CES approval required for "${name}" but no CES client is available. Ensure the Credential Execution Service is running.`;
        const durationMs = Date.now() - startTime;
        emitLifecycleEvent(context, {
          type: "error",
          toolName: name,
          executionTarget,
          input,
          workingDir: context.workingDir,
          conversationId: context.conversationId,
          requestId: context.requestId,
          riskLevel,
          matchedTrustRuleId: permMatchedTrustRuleId,
          decision: "error",
          durationMs,
          errorMessage: msg,
          isExpected: true,
          errorCategory: "tool_failure",
        });
        return { content: msg, isError: true };
      }
      if (execResult.cesApprovalRequired && cesClient) {
        const bridgeResult = await bridgeCesApproval(
          execResult.cesApprovalRequired,
          this.prompter,
          cesClient,
          {
            isInteractive: context.isInteractive,
            conversationId: context.conversationId,
            signal: context.signal,
          },
        );

        if (bridgeResult.outcome === "approved") {
          // Retry the original tool invocation with the grantId attached.
          // The CES tool implementations accept grantId in the input to
          // bypass the approval check on the retry.
          const retryInput = { ...input, grantId: bridgeResult.grantId };

          log.info(
            {
              toolName: name,
              grantId: bridgeResult.grantId,
              conversationId: context.conversationId,
            },
            "CES approval granted - retrying tool invocation with grantId",
          );

          execResult = await executeWithTimeout(
            tool.execute(retryInput, execContext),
            toolTimeoutMs,
            name,
          );
        } else if (
          bridgeResult.outcome === "denied" ||
          bridgeResult.outcome === "timeout"
        ) {
          const denialReason =
            bridgeResult.outcome === "timeout"
              ? `CES approval timed out for "${name}". The tool was not executed.`
              : `CES approval denied for "${name}". The tool was not executed.`;
          const durationMs = Date.now() - startTime;
          emitLifecycleEvent(context, {
            type: "permission_denied",
            toolName: name,
            executionTarget,
            input,
            workingDir: context.workingDir,
            conversationId: context.conversationId,
            requestId: context.requestId,
            riskLevel,
            matchedTrustRuleId: permMatchedTrustRuleId,
            decision: "deny",
            reason: denialReason,
            durationMs,
          });
          return { content: denialReason, isError: true };
        } else {
          // bridgeResult.outcome === "error"
          const errorMsg = `CES approval bridge error for "${name}": ${bridgeResult.message}`;
          const durationMs = Date.now() - startTime;
          emitLifecycleEvent(context, {
            type: "error",
            toolName: name,
            executionTarget,
            input,
            workingDir: context.workingDir,
            conversationId: context.conversationId,
            requestId: context.requestId,
            riskLevel,
            matchedTrustRuleId: permMatchedTrustRuleId,
            decision: "error",
            durationMs,
            errorMessage: errorMsg,
            isExpected: true,
            errorCategory: "tool_failure",
          });
          return { content: errorMsg, isError: true };
        }
      }

      // Sized from the RAW pre-sanitization result — sensitive-output
      // extraction below strips directives and swaps raw values for
      // placeholders, which changes the content length, and telemetry must
      // report the true payload size. Only the size leaves the device,
      // never the payload. Stamped here (not centrally in
      // emitLifecycleEvent) because only this site sees the content before
      // extractAndSanitize() rewrites it.
      const rawResultBytes = Buffer.byteLength(execResult.content, "utf8");

      // Sensitive output extraction: strip directives, replace raw values
      // with placeholders, and attach bindings for agent-loop substitution.
      const { sanitizedContent, bindings } = extractAndSanitize(
        execResult.content,
      );
      if (bindings.length > 0) {
        execResult = {
          ...execResult,
          content: sanitizedContent,
          sensitiveBindings: bindings,
        };
      }

      const durationMs = Date.now() - startTime;
      // Strip sensitiveBindings from lifecycle event to prevent raw values leaking
      const { sensitiveBindings: _sb, ...safeResult } = execResult;
      emitLifecycleEvent(context, {
        type: "executed",
        toolName: name,
        executionTarget,
        input,
        workingDir: context.workingDir,
        conversationId: context.conversationId,
        requestId: context.requestId,
        riskLevel,
        matchedTrustRuleId: permMatchedTrustRuleId,
        approvalMode: permApprovalMode,
        approvalReason: permApprovalReason,
        decision,
        durationMs,
        result: safeResult,
        resultBytes: rawResultBytes,
      });

      // Merge risk metadata from the classifier assessment cache onto the
      // tool result so downstream consumers (AgentEvent → handleToolResult →
      // ToolResult SSE message) can forward it to the client.
      if (permRiskMeta) {
        execResult = {
          ...execResult,
          riskLevel: permRiskMeta.riskLevel,
          riskReason: permRiskMeta.riskReason,
          riskScopeOptions: permRiskMeta.riskScopeOptions,
          riskAllowlistOptions: permRiskMeta.riskAllowlistOptions,
          riskDirectoryScopeOptions: permRiskMeta.riskDirectoryScopeOptions,
          isContainerized: permRiskMeta.isContainerized,
        };
      }
      if (permMatchedTrustRuleId) {
        execResult = {
          ...execResult,
          matchedTrustRuleId: permMatchedTrustRuleId,
        };
      }
      if (permApprovalMode) {
        execResult = { ...execResult, approvalMode: permApprovalMode };
      }
      if (permApprovalReason) {
        execResult = { ...execResult, approvalReason: permApprovalReason };
      }
      if (permRiskThreshold) {
        execResult = { ...execResult, riskThreshold: permRiskThreshold };
      }

      return execResult;
    } catch (err) {
      // Extract classified risk level if the PermissionChecker attached it
      // before re-throwing. This preserves audit accuracy for high-risk
      // tool attempts that fail mid-permission-evaluation.
      if (
        err instanceof Error &&
        typeof (err as Error & { riskLevel?: string }).riskLevel === "string"
      ) {
        riskLevel = (err as Error & { riskLevel?: string }).riskLevel!;
      }

      const durationMs = Date.now() - startTime;
      // Daemon-owned aborts surface as a tagged AbortReason — a plain object
      // thrown verbatim by `AbortSignal.throwIfAborted()`, carried on
      // `error.reason`, or stamped on a provider wrapper's `abortReason`.
      // Recognize it before the generic stringification below, which would
      // render it "[object Object]" and misfile the cancellation as an
      // unexpected failure.
      const abortReason = extractAbortReason(err);
      const msg = abortReason
        ? `Tool execution was cancelled (${abortReason.kind}).`
        : err instanceof Error
          ? err.message
          : describeThrownValue(err);
      const isAbort =
        abortReason !== undefined ||
        (err instanceof Error && err.name === "AbortError");
      const isExpected =
        isAbort ||
        err instanceof PermissionDeniedError ||
        err instanceof ToolError ||
        err instanceof TokenExpiredError;

      const errorCategory = isAbort
        ? ("tool_failure" as const)
        : err instanceof PermissionDeniedError
          ? ("permission_denied" as const)
          : err instanceof TokenExpiredError
            ? ("auth" as const)
            : err instanceof ToolError
              ? ("tool_failure" as const)
              : ("unexpected" as const);

      emitLifecycleEvent(context, {
        type: "error",
        toolName: name,
        executionTarget,
        input,
        workingDir: context.workingDir,
        conversationId: context.conversationId,
        requestId: context.requestId,
        riskLevel,
        matchedTrustRuleId: permMatchedTrustRuleId,
        decision: "error",
        durationMs,
        errorMessage: msg,
        isExpected,
        errorCategory,
        errorName: err instanceof Error ? err.name : undefined,
        errorStack: err instanceof Error ? err.stack : undefined,
      });

      if (isExpected) {
        return { content: msg, isError: true };
      }
      return {
        content: `Tool "${name}" encountered an unexpected error: ${msg}`,
        isError: true,
      };
    }
  }
}

/**
 * Extract the tagged {@link AbortReason} from a thrown value: the value
 * itself, its `reason` (an `AbortError` carrying the signal's reason), or a
 * provider wrapper's `abortReason`. Returns `undefined` for anything that is
 * not a daemon-owned abort.
 */
function extractAbortReason(err: unknown): AbortReason | undefined {
  if (isAbortReason(err)) {
    return err;
  }
  const reason = (err as { reason?: unknown } | null)?.reason;
  if (isAbortReason(reason)) {
    return reason;
  }
  const abortReason = (err as { abortReason?: unknown } | null)?.abortReason;
  if (isAbortReason(abortReason)) {
    return abortReason;
  }
  return undefined;
}

/**
 * Render a thrown non-Error value for the error result and audit trail.
 * Objects are JSON-rendered so a thrown `{status: 429}` reads as itself
 * rather than "[object Object]", bounded so a large payload cannot flood
 * the audit row; cyclic or non-serializable values fall back to String().
 */
function describeThrownValue(err: unknown): string {
  if (typeof err === "string") {
    return err;
  }
  try {
    const json = JSON.stringify(err);
    if (typeof json === "string") {
      return truncateForLog(json, 500);
    }
  } catch {
    // Cyclic or otherwise non-serializable — fall through to String().
  }
  return String(err);
}

// Re-export from the canonical source so existing consumers of
// `executor.ts` continue to work without changing their imports.
export { isSideEffectTool } from "./side-effects.js";

/**
 * Compute the effective per-tool execution timeout in milliseconds.
 *
 * Shell tools (`bash`, `host_bash`) manage their own timeouts with SIGKILL
 * on expiry. We add a 5s buffer so the shell's own deadline fires first and
 * handles cleanup before the executor wrapper trips.
 *
 * `ask_question` blocks on user input inside `execute()` via `QuestionPrompter`,
 * which waits up to `questionResponseTimeoutSec`. We give the wrapper the same
 * 5s buffer over that deadline so the prompter's own timeout fires first and
 * returns its clean "User did not respond within timeout" result — otherwise
 * the shorter generic budget trips first, orphaning the still-pending prompt
 * behind the confusing "may still be running in the background" error.
 *
 * All other tools use the generic `toolExecutionTimeoutSec` configuration value.
 *
 * Consumed by `executeInternal` via `executeWithTimeout`, which is the
 * sole enforcer of the per-tool budget.
 */
export function computePerToolTimeoutMs(
  name: string,
  input: Record<string, unknown>,
): number {
  if (name === "bash" || name === "host_bash") {
    const { shellDefaultTimeoutSec, shellMaxTimeoutSec } = getConfig().timeouts;
    const requestedSec =
      typeof input.timeout_seconds === "number"
        ? input.timeout_seconds
        : shellDefaultTimeoutSec;
    const shellTimeoutSec = Math.max(
      1,
      Math.min(requestedSec, shellMaxTimeoutSec),
    );
    return (shellTimeoutSec + 5) * 1000;
  }
  if (name === "ask_question") {
    const { questionResponseTimeoutSec } = getConfig().timeouts;
    return (questionResponseTimeoutSec + 5) * 1000;
  }
  const rawTimeoutSec = getConfig().timeouts.toolExecutionTimeoutSec;
  return safeTimeoutMs(rawTimeoutSec);
}

/**
 * Sanitize tool inputs before they are emitted in lifecycle events.
 * Applies recursive field-level redaction for known-sensitive keys.
 */
function sanitizeToolInput(
  _toolName: string,
  input: Record<string, unknown>,
): Record<string, unknown> {
  return redactSensitiveFields(input);
}

function emitLifecycleEvent(
  context: ToolContext,
  event: ToolLifecycleEvent,
): void {
  const handler = context.onToolLifecycleEvent;
  if (!handler) {
    return;
  }

  // Redact sensitive fields from tool inputs before they reach audit listeners
  const sanitizedEvent = {
    ...event,
    input: sanitizeToolInput(event.toolName, event.input),
  };

  // Stamp telemetry fields centrally so every executed/error event carries
  // them — including the pre-execution gate failures (aborted, disk
  // pressure, unknown/inactive tool) emitted from checkPreExecutionGates(),
  // whose emission sites don't have to remember to copy them. This is the
  // sole writer of both fields. (`resultBytes` is the exception: it is
  // stamped at the executed emission site in executeInternal, the only
  // place that sees the result content before sensitive-output extraction
  // rewrites it; the spread above passes it through untouched.)
  if (sanitizedEvent.type === "executed" || sanitizedEvent.type === "error") {
    sanitizedEvent.attribution = context.attribution ?? null;
    // Sized from the RAW pre-sanitization input — redaction changes the
    // serialized length, and telemetry must report the true payload size.
    // Only the size leaves the device, never the payload.
    sanitizedEvent.inputBytes = Buffer.byteLength(
      stringifyToolInput(event.input),
      "utf8",
    );
  }

  try {
    const maybePromise = handler(sanitizedEvent as ToolLifecycleEvent);
    if (maybePromise) {
      void maybePromise.catch((err) => {
        log.warn(
          { err, eventType: event.type, toolName: event.toolName },
          "Tool lifecycle event handler failed (non-fatal, tool execution was not affected)",
        );
      });
    }
  } catch (err) {
    log.warn(
      { err, eventType: event.type, toolName: event.toolName },
      "Tool lifecycle event handler failed (non-fatal, tool execution was not affected)",
    );
  }
}

/**
 * Compute a preview diff for file tools so the confirmation prompt can show
 * what will change. Returns undefined for non-file tools or on any error.
 */
function computePreviewDiff(
  toolName: string,
  input: Record<string, unknown>,
  workingDir: string,
):
  | {
      filePath: string;
      oldContent: string;
      newContent: string;
      isNewFile: boolean;
    }
  | undefined {
  try {
    if (toolName === "file_write") {
      const rawPath = input.path as string;
      const content = input.content as string;
      if (!rawPath || typeof content !== "string") {
        return undefined;
      }
      const pathCheck = sandboxPolicy(rawPath, workingDir, {
        mustExist: false,
      });
      if (!pathCheck.ok) {
        return undefined;
      }
      const filePath = pathCheck.resolved;
      const isNewFile = !pathExists(filePath);
      if (!isNewFile) {
        const stat = safeStatSync(filePath);
        if (!stat || stat.size > MAX_FILE_SIZE_BYTES) {
          return undefined;
        }
      }
      const oldContent = isNewFile ? "" : readFileSync(filePath, "utf-8");
      return { filePath, oldContent, newContent: content, isNewFile };
    }

    if (toolName === "file_edit") {
      const rawPath = input.path as string;
      const oldString = input.old_string as string;
      const newString = input.new_string as string;
      if (
        !rawPath ||
        typeof oldString !== "string" ||
        typeof newString !== "string" ||
        oldString.length === 0
      ) {
        return undefined;
      }
      const pathCheck = sandboxPolicy(rawPath, workingDir);
      if (!pathCheck.ok) {
        return undefined;
      }
      const filePath = pathCheck.resolved;
      const stat = safeStatSync(filePath);
      if (!stat) {
        return undefined;
      }
      if (stat.size > MAX_FILE_SIZE_BYTES) {
        return undefined;
      }
      const content = readFileSync(filePath, "utf-8");
      const replaceAll = input.replace_all === true;
      const result = applyEdit(content, oldString, newString, replaceAll);
      if (!result.ok) {
        return undefined;
      }
      return {
        filePath,
        oldContent: content,
        newContent: result.updatedContent,
        isNewFile: false,
      };
    }
  } catch {
    // Preview is best-effort - don't block the prompt on errors
  }
  return undefined;
}
