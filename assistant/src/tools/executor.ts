import { readFileSync } from "node:fs";

import { getConfig } from "../config/loader.js";
import { bridgeCesApproval } from "../credential-execution/approval-bridge.js";
import { isCesShellLockdownEnabled } from "../credential-execution/feature-gates.js";
import { getHookManager } from "../hooks/manager.js";
import { PermissionPrompter } from "../permissions/prompter.js";
import { RiskLevel } from "../permissions/types.js";
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
      sessionId: context.sessionId,
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
      // skip this assignment entirely — defeating the lockdown.
      if (
        name === "host_bash" &&
        isCesShellLockdownEnabled(getConfig()) &&
        isUntrustedTrustClass(context.trustClass)
      ) {
        context.forcePromptSideEffects = true;
      }

      // A consumed scoped grant is a complete authorization — skip the
      // interactive permission/prompt flow so non-interactive sessions
      // don't auto-deny prompt-gated tools and burn the one-time grant.
      if (!gateResult.grantConsumed) {
        // Check permissions via the extracted PermissionChecker
        const permResult = await this.permissionChecker.checkPermission(
          name,
          input,
          tool,
          context,
          executionTarget,
          (event) => emitLifecycleEvent(context, event),
          sanitizeToolInput,
          startTime,
          computePreviewDiff,
        );

        riskLevel = permResult.riskLevel;
        decision = permResult.decision;

        if (!permResult.allowed) {
          return { content: permResult.content, isError: true };
        }
      }

      const hookResult = await getHookManager().trigger("pre-tool-execute", {
        toolName: name,
        input: sanitizeToolInput(name, input),
        riskLevel,
        decision,
        workingDir: context.workingDir,
        sessionId: context.sessionId,
      });

      if (hookResult.blocked) {
        const msg = `Tool execution blocked by hook "${hookResult.blockedBy}"`;
        const durationMs = Date.now() - startTime;
        emitLifecycleEvent(context, {
          type: "error",
          toolName: name,
          executionTarget,
          input,
          workingDir: context.workingDir,
          sessionId: context.sessionId,
          conversationId: context.conversationId,
          requestId: context.requestId,
          riskLevel,
          decision: "blocked",
          durationMs,
          errorMessage: msg,
          isExpected: true,
          errorCategory: "tool_failure",
        });
        return { content: msg, isError: true };
      }

      // Execute the tool — proxy tools delegate to an external resolver
      let execResult: ToolExecutionResult;
      let toolTimeoutMs: number;
      if (name === "bash" || name === "host_bash") {
        // Shell tools manage their own timeouts (SIGKILL on expiry).
        // Compute the same effective timeout so the executor wrapper
        // doesn't prematurely kill them with the generic toolExecutionTimeoutSec.
        const { shellDefaultTimeoutSec, shellMaxTimeoutSec } =
          getConfig().timeouts;
        const requestedSec =
          typeof input.timeout_seconds === "number"
            ? input.timeout_seconds
            : shellDefaultTimeoutSec;
        const shellTimeoutSec = Math.max(
          1,
          Math.min(requestedSec, shellMaxTimeoutSec),
        );
        // Buffer so the shell's own timeout fires first and handles cleanup
        toolTimeoutMs = (shellTimeoutSec + 5) * 1000;
      } else if (name === "claude_code") {
        // Claude Code spawns a subprocess that manages its own turn limits
        // (maxTurns). Give it a generous timeout so it isn't killed mid-task.
        toolTimeoutMs = 10 * 60 * 1000; // 10 minutes
      } else {
        const rawTimeoutSec = getConfig().timeouts.toolExecutionTimeoutSec;
        toolTimeoutMs = safeTimeoutMs(rawTimeoutSec);
      }

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
            sessionId: context.sessionId,
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
          sessionId: context.sessionId,
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
            sessionId: context.sessionId,
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
              sessionId: context.sessionId,
            },
            "CES approval granted — retrying tool invocation with grantId",
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
            sessionId: context.sessionId,
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
            sessionId: context.sessionId,
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
        sanitizeToolInput,
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
        sessionId: context.sessionId,
        conversationId: context.conversationId,
        requestId: context.requestId,
        riskLevel,
        decision,
        durationMs,
        result: safeResult,
      });

      void getHookManager().trigger("post-tool-execute", {
        toolName: name,
        input: sanitizeToolInput(name, input),
        riskLevel,
        isError: execResult.isError,
        durationMs,
        sessionId: context.sessionId,
      });

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
        sessionId: context.sessionId,
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

      void getHookManager().trigger("post-tool-execute", {
        toolName: name,
        input: sanitizeToolInput(name, input),
        riskLevel,
        isError: true,
        durationMs,
        sessionId: context.sessionId,
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
 * Sanitize tool inputs before they are emitted in lifecycle events and hooks.
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
    // Preview is best-effort — don't block the prompt on errors
  }
  return undefined;
}
