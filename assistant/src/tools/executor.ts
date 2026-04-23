import { readFileSync } from "node:fs";

import { parseChannelId } from "../channels/types.js";
import { getConfig } from "../config/loader.js";
import { bridgeCesApproval } from "../credential-execution/approval-bridge.js";
import { isCesShellLockdownEnabled } from "../credential-execution/feature-gates.js";
import { PermissionPrompter } from "../permissions/prompter.js";
import { RiskLevel } from "../permissions/types.js";
import { runPipeline } from "../plugins/pipeline.js";
import { getMiddlewaresFor } from "../plugins/registry.js";
import type {
  ToolExecuteArgs,
  ToolExecuteResult,
  TurnContext,
} from "../plugins/types.js";
import { isUntrustedTrustClass } from "../runtime/actor-trust-resolver.js";
import { redactSensitiveFields } from "../security/redaction.js";
import { TokenExpiredError } from "../security/token-manager.js";
import { PermissionDeniedError, ToolError } from "../util/errors.js";
import { pathExists, safeStatSync } from "../util/fs.js";
import { getLogger } from "../util/logger.js";
import { resolveExecutionTarget } from "./execution-target.js";
import { executeWithTimeout, safeTimeoutMs } from "./execution-timeout.js";
import { PermissionChecker } from "./permission-checker.js";
import { SecretDetectionHandler } from "./secret-detection-handler.js";
import { extractAndSanitize } from "./sensitive-output-placeholders.js";
import { applyEdit } from "./shared/filesystem/edit-engine.js";
import { sandboxPolicy } from "./shared/filesystem/path-policy.js";
import { MAX_FILE_SIZE_BYTES } from "./shared/filesystem/size-guard.js";
import { ToolApprovalHandler } from "./tool-approval-handler.js";
import type {
  ToolContext,
  ToolExecutionResult,
  ToolLifecycleEvent,
} from "./types.js";

const log = getLogger("tool-executor");

export class ToolExecutor {
  private prompter: PermissionPrompter;
  private permissionChecker: PermissionChecker;
  private secretDetectionHandler: SecretDetectionHandler;
  private approvalHandler: ToolApprovalHandler;

  constructor(prompter: PermissionPrompter) {
    this.prompter = prompter;
    this.permissionChecker = new PermissionChecker(prompter);
    this.secretDetectionHandler = new SecretDetectionHandler(prompter);
    this.approvalHandler = new ToolApprovalHandler();
  }

  async execute(
    name: string,
    input: Record<string, unknown>,
    context: ToolContext,
    /**
     * Optional per-turn context threaded in by the agent loop. Production
     * sites propagate the orchestrator-built `TurnContext` (real
     * `conversationId`, trust cascade, attached `contextWindowManager`) so
     * middleware registered on the `toolExecute` pipeline sees the same
     * context every other pipeline slot uses. When omitted (CLI/test
     * invocations that call `ToolExecutor.execute` directly), the executor
     * synthesizes a fallback context from the {@link ToolContext}, which
     * keeps pre-threading behavior intact for legacy callers.
     */
    turnContext?: TurnContext,
  ): Promise<ToolExecutionResult> {
    // Prefer the orchestrator-supplied `turnContext` so the pipeline sees
    // the real conversation identity, per-turn trust, and context-window
    // manager. When absent (CLI / test invocations that bypass the agent
    // loop), synthesize a minimal context from the `ToolContext` — the
    // same fallback the executor has used since the pipeline was added.
    const turnCtx: TurnContext = turnContext ?? {
      requestId: context.requestId ?? "",
      conversationId: context.conversationId,
      turnIndex: 0,
      trust: {
        sourceChannel: parseChannelId(context.executionChannel) ?? "vellum",
        trustClass: context.trustClass,
      },
    };

    const middlewares = getMiddlewaresFor("toolExecute");
    const pipelineArgs: ToolExecuteArgs = { name, input, context };

    // No pipeline-level timeout: `executeInternal` already wraps the real
    // tool invocation in `executeWithTimeout`, which is the sole enforcer
    // of the per-tool budget. Propagating `perToolTimeoutMs` to
    // `runPipeline` made the pipeline race everything upstream of the
    // tool call — permission checks, approval waits, middleware — against
    // the same budget, so a slow human clicking "allow" produced a
    // `PluginTimeoutError` thrown past `executeInternal`'s catch block,
    // breaking the `execute()` never-throws contract. Letting the pipeline
    // run untimed keeps the contract intact; runaway middleware is a
    // plugin-health concern handled by per-plugin timeouts, not here.
    return runPipeline<ToolExecuteArgs, ToolExecuteResult>(
      "toolExecute",
      middlewares,
      (args) => this.executeInternal(args.name, args.input, args.context),
      pipelineArgs,
      turnCtx,
    );
  }

  private async executeInternal(
    name: string,
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    const startTime = Date.now();
    let decision = "allow";
    let riskLevel: string = RiskLevel.Low;
    const executionTarget = resolveExecutionTarget(name);

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
        isCesShellLockdownEnabled(getConfig()) &&
        isUntrustedTrustClass(context.trustClass)
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

      // A consumed scoped grant is a complete authorization - skip the
      // interactive permission/prompt flow so non-interactive sessions
      // don't auto-deny prompt-gated tools and burn the one-time grant.
      // Exception: requireFreshApproval tools always go through the
      // permission check even when a grant was consumed - the grant does
      // not substitute for an interactive human review.
      let permRiskMeta:
        | {
            riskLevel: string;
            riskReason: string;
            riskScopeOptions: Array<{ pattern: string; label: string }>;
            isContainerized?: boolean;
          }
        | undefined;
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

        if (!permResult.allowed) {
          return {
            content: permResult.content,
            isError: true,
            riskLevel: permRiskMeta?.riskLevel,
            riskReason: permRiskMeta?.riskReason,
            riskScopeOptions: permRiskMeta?.riskScopeOptions,
            isContainerized: permRiskMeta?.isContainerized,
          };
        }

        if (permResult.wasPrompted) {
          context.approvedViaPrompt = true;
        }
      }

      // Execute the tool - proxy tools delegate to an external resolver.
      // Use the shared per-tool timeout helper so the pipeline runner and
      // the inner execute-with-timeout wrapper agree on the same budget.
      let execResult: ToolExecutionResult;
      const toolTimeoutMs = computePerToolTimeoutMs(name, input);

      const execContext = context;

      if (tool.executionMode === "proxy") {
        if (!context.proxyToolResolver) {
          const msg = `No proxy resolver configured for proxy tool "${name}". This tool requires an external resolver (e.g. a connected macOS client for computer-use tools).`;
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
            decision: "error",
            durationMs,
            errorMessage: msg,
            isExpected: true,
            errorCategory: "tool_failure",
          });
          return { content: msg, isError: true };
        }
        execResult = await executeWithTimeout(
          context.proxyToolResolver(name, input),
          toolTimeoutMs,
          name,
        );
      } else {
        execResult = await executeWithTimeout(
          tool.execute(input, execContext),
          toolTimeoutMs,
          name,
        );
      }

      // CES approval bridge: if the tool returned an approval_required
      // indicator, present the proposal to the guardian via the existing
      // confirmation transport, commit the decision to CES, and retry
      // the original tool invocation with the granted grantId.
      if (execResult.cesApprovalRequired && !context.cesClient) {
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
          decision: "error",
          durationMs,
          errorMessage: msg,
          isExpected: true,
          errorCategory: "tool_failure",
        });
        return { content: msg, isError: true };
      }
      if (execResult.cesApprovalRequired && context.cesClient) {
        const bridgeResult = await bridgeCesApproval(
          execResult.cesApprovalRequired,
          this.prompter,
          context.cesClient,
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

          if (tool.executionMode === "proxy") {
            execResult = await executeWithTimeout(
              context.proxyToolResolver!(name, retryInput),
              toolTimeoutMs,
              name,
            );
          } else {
            execResult = await executeWithTimeout(
              tool.execute(retryInput, execContext),
              toolTimeoutMs,
              name,
            );
          }
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
            decision: "error",
            durationMs,
            errorMessage: errorMsg,
            isExpected: true,
            errorCategory: "tool_failure",
          });
          return { content: errorMsg, isError: true };
        }
      }

      // Sensitive output extraction: strip directives, replace raw values
      // with placeholders, and attach bindings for agent-loop substitution.
      // Runs before secret detection so that raw sensitive values are already
      // replaced and won't trigger entropy-based redaction.
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

      // Secret detection on tool output
      const secretResult = await this.secretDetectionHandler.handle(
        execResult,
        name,
        input,
        context,
        executionTarget,
        riskLevel,
        decision,
        startTime,
        emitLifecycleEvent,
      );
      if (secretResult.earlyReturn) {
        return secretResult.result;
      }
      execResult = secretResult.result;

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
        decision,
        durationMs,
        result: safeResult,
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
          isContainerized: permRiskMeta.isContainerized,
        };
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
      const msg = err instanceof Error ? err.message : String(err);
      const isAbort = err instanceof Error && err.name === "AbortError";
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

// Re-export from the canonical source so existing consumers of
// `executor.ts` continue to work without changing their imports.
export { isSideEffectTool } from "./side-effects.js";

// Re-export PermissionChecker for consumers that need direct access
export { PermissionChecker } from "./permission-checker.js";

/**
 * Compute the effective per-tool execution timeout in milliseconds.
 *
 * Shell tools (`bash`, `host_bash`) manage their own timeouts with SIGKILL
 * on expiry. We add a 5s buffer so the shell's own deadline fires first and
 * handles cleanup before the executor wrapper trips. Non-shell tools use
 * the generic `toolExecutionTimeoutSec` configuration value.
 *
 * Consumed by `executeInternal` via `executeWithTimeout`, which is the
 * sole enforcer of the per-tool budget.
 */
function computePerToolTimeoutMs(
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
  if (!handler) return;

  // Redact sensitive fields from tool inputs before they reach audit listeners
  const sanitizedEvent = {
    ...event,
    input: sanitizeToolInput(event.toolName, event.input),
  };

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
      if (!rawPath || typeof content !== "string") return undefined;
      const pathCheck = sandboxPolicy(rawPath, workingDir, {
        mustExist: false,
      });
      if (!pathCheck.ok) return undefined;
      const filePath = pathCheck.resolved;
      const isNewFile = !pathExists(filePath);
      if (!isNewFile) {
        const stat = safeStatSync(filePath);
        if (!stat || stat.size > MAX_FILE_SIZE_BYTES) return undefined;
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
      )
        return undefined;
      const pathCheck = sandboxPolicy(rawPath, workingDir);
      if (!pathCheck.ok) return undefined;
      const filePath = pathCheck.resolved;
      const stat = safeStatSync(filePath);
      if (!stat) return undefined;
      if (stat.size > MAX_FILE_SIZE_BYTES) return undefined;
      const content = readFileSync(filePath, "utf-8");
      const replaceAll = input.replace_all === true;
      const result = applyEdit(content, oldString, newString, replaceAll);
      if (!result.ok) return undefined;
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
