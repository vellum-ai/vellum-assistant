import { readFileSync, existsSync, statSync } from 'node:fs';
import { getTool, getAllTools } from './registry.js';
import type { ExecutionTarget, Tool, ToolContext, ToolExecutionResult, ToolLifecycleEvent } from './types.js';
import { RiskLevel } from '../permissions/types.js';
import type { PolicyContext } from '../permissions/types.js';
import { check, classifyRisk, generateAllowlistOptions, generateScopeOptions } from '../permissions/checker.js';
import { addRule } from '../permissions/trust-store.js';
import { PermissionPrompter } from '../permissions/prompter.js';
import { ToolError, PermissionDeniedError } from '../util/errors.js';
import { TokenExpiredError } from '../security/token-manager.js';
import { getLogger } from '../util/logger.js';
import { sandboxPolicy } from './shared/filesystem/path-policy.js';
import { MAX_FILE_SIZE_BYTES } from './shared/filesystem/size-guard.js';
import { applyEdit } from './shared/filesystem/edit-engine.js';
import { wrapCommand } from './terminal/sandbox.js';
import { getConfig } from '../config/loader.js';
import { scanText, redactSecrets } from '../security/secret-scanner.js';
import { redactSensitiveFields } from '../security/redaction.js';
import { getHookManager } from '../hooks/manager.js';
import { getTaskRunRules } from '../tasks/ephemeral-permissions.js';

const log = getLogger('tool-executor');

export class ToolExecutor {
  private prompter: PermissionPrompter;

  constructor(prompter: PermissionPrompter) {
    this.prompter = prompter;
  }

  async execute(
    name: string,
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    const startTime = Date.now();
    let decision = 'allow';
    let riskLevel: string = RiskLevel.Low;
    const executionTarget = resolveExecutionTarget(name);

    emitLifecycleEvent(context, {
      type: 'start',
      toolName: name,
      executionTarget,
      input,
      workingDir: context.workingDir,
      sessionId: context.sessionId,
      conversationId: context.conversationId,
      requestId: context.requestId,
      startedAtMs: startTime,
    });

    // Gate tools not active for the current turn
    if (context.allowedToolNames && !context.allowedToolNames.has(name)) {
      const msg = `Tool "${name}" is not currently active. Load the skill that provides this tool first.`;
      const durationMs = Date.now() - startTime;
      emitLifecycleEvent(context, {
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
      return { content: msg, isError: true };
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
        emitLifecycleEvent(context, {
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
        return { content: msg, isError: true };
      }
    }

    const tool = getTool(name);
    if (!tool) {
      const available = getAllTools().filter((t) => t.executionMode !== 'proxy' || context.proxyToolResolver).map((t) => t.name).sort().join(', ');
      const msg = `Unknown tool: ${name}. Available tools: ${available}`;
      const durationMs = Date.now() - startTime;
      emitLifecycleEvent(context, {
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
      return { content: msg, isError: true };
    }

    try {
      // Check permissions
      const risk = await classifyRisk(name, input, context.workingDir);
      riskLevel = risk;

      // Build principal context from tool metadata so policy rules can
      // distinguish skill-provided tools from core built-ins. Also includes
      // ephemeral rules when executing within a task run.
      const policyContext = buildPolicyContext(tool, context);
      const result = await check(name, input, context.workingDir, policyContext);

      // Private threads force prompting for side-effect tools even when a
      // trust/allow rule would auto-allow. Deny decisions are preserved —
      // only allow → prompt promotion happens here.
      if (
        context.forcePromptSideEffects
        && result.decision === 'allow'
        && isSideEffectTool(name, input)
      ) {
        result.decision = 'prompt';
        result.reason = 'Private thread: side-effect tools require explicit approval';
      }

      if (result.decision === 'deny') {
        decision = 'denied';
        const durationMs = Date.now() - startTime;
        emitLifecycleEvent(context, {
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
          reason: result.reason,
          durationMs,
        });
        return { content: result.reason, isError: true };
      }

      if (result.decision === 'prompt') {
        // Non-interactive sessions have no client to respond to prompts —
        // deny immediately instead of blocking for the full permission timeout.
        if (context.isInteractive === false) {
          decision = 'denied';
          const durationMs = Date.now() - startTime;
          log.info({ toolName: name, riskLevel }, 'Auto-denying prompt for non-interactive session');
          emitLifecycleEvent(context, {
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
            reason: 'Non-interactive session: no client to approve prompt',
            durationMs,
          });
          return {
            content: `Permission denied: tool "${name}" requires user approval but no interactive client is connected. The tool was not executed. To allow this tool in non-interactive sessions, add a trust rule via permission settings.`,
            isError: true,
          };
        }

        // Need user approval
        const allowlistOptions = generateAllowlistOptions(name, input);
        const scopeOptions = generateScopeOptions(context.workingDir, name);

        // Compute preview diff for file tools so the user sees what will change
        const previewDiff = computePreviewDiff(name, input, context.workingDir);

        let sandboxed: boolean | undefined;
        if (name === 'bash' && typeof input.command === 'string') {
          const cfg = getConfig();
          const sandboxConfig = context.sandboxOverride != null
            ? { ...cfg.sandbox, enabled: context.sandboxOverride }
            : cfg.sandbox;
          const wrapped = wrapCommand(input.command, context.workingDir, sandboxConfig);
          sandboxed = wrapped.sandboxed;
        }

        // Proxied bash prompts are non-persistent — no trust rule saving allowed
        const persistentDecisionsAllowed = !(
          name === 'bash'
          && input.network_mode === 'proxied'
        );

        emitLifecycleEvent(context, {
          type: 'permission_prompt',
          toolName: name,
          executionTarget,
          input,
          workingDir: context.workingDir,
          sessionId: context.sessionId,
          conversationId: context.conversationId,
          requestId: context.requestId,
          riskLevel,
          reason: result.reason,
          allowlistOptions,
          scopeOptions,
          diff: previewDiff,
          sandboxed,
          persistentDecisionsAllowed,
        });

        await getHookManager().trigger('permission-request', {
          toolName: name,
          input: sanitizeToolInput(name, input),
          riskLevel,
          sessionId: context.sessionId,
        });

        const response = await this.prompter.prompt(
          name,
          input,
          riskLevel,
          allowlistOptions,
          scopeOptions,
          previewDiff,
          sandboxed,
          context.conversationId,
          executionTarget,
          policyContext?.principal ? {
            kind: policyContext.principal.kind,
            id: policyContext.principal.id,
            version: policyContext.principal.version,
          } : undefined,
          persistentDecisionsAllowed,
        );

        decision = response.decision;

        await getHookManager().trigger('permission-resolve', {
          toolName: name,
          decision: response.decision,
          riskLevel,
          sessionId: context.sessionId,
        });

        if (response.decision === 'deny') {
          const denialMessage = `Permission denied by user. The user chose not to allow the "${name}" tool. Do NOT retry this tool call immediately. Instead, tell the user that the action was not performed because they denied permission, and ask if they would like you to try again or take a different approach. Wait for the user to explicitly respond before retrying.`;
          const durationMs = Date.now() - startTime;
          emitLifecycleEvent(context, {
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
            reason: 'Permission denied by user',
            durationMs,
          });
          return { content: denialMessage, isError: true };
        }

        if (response.decision === 'always_deny') {
          const ruleSaved = !!(persistentDecisionsAllowed && response.selectedPattern && response.selectedScope);
          if (ruleSaved) {
            addRule(name, response.selectedPattern!, response.selectedScope!, 'deny');
          }
          const denialReason = ruleSaved ? 'Permission denied by user (rule saved)' : 'Permission denied by user';
          const denialMessage = ruleSaved
            ? `Permission denied by user, and a rule was saved to always deny the "${name}" tool for this pattern. Do NOT retry this tool call. Inform the user that this action has been permanently blocked by their preference. If the user wants to allow it in the future, they can update their permission rules.`
            : `Permission denied by user. The user chose not to allow the "${name}" tool. Do NOT retry this tool call immediately. Instead, tell the user that the action was not performed because they denied permission, and ask if they would like you to try again or take a different approach. Wait for the user to explicitly respond before retrying.`;
          const durationMs = Date.now() - startTime;
          emitLifecycleEvent(context, {
            type: 'permission_denied',
            toolName: name,
            executionTarget,
            input,
            workingDir: context.workingDir,
            sessionId: context.sessionId,
            conversationId: context.conversationId,
            requestId: context.requestId,
            riskLevel,
            decision: 'always_deny',
            reason: denialReason,
            durationMs,
          });
          return { content: denialMessage, isError: true };
        }

        if (
          persistentDecisionsAllowed
          && (response.decision === 'always_allow' || response.decision === 'always_allow_high_risk')
          && response.selectedPattern
          && response.selectedScope
        ) {
          const ruleOptions: {
            allowHighRisk?: boolean;
            principalKind?: string;
            principalId?: string;
            principalVersion?: string;
            executionTarget?: string;
          } = {};

          if (response.decision === 'always_allow_high_risk') {
            ruleOptions.allowHighRisk = true;
          }

          // Capture the principal context from the tool so the saved rule
          // is scoped to the specific skill/version that was approved.
          if (policyContext?.principal) {
            if (policyContext.principal.kind != null) {
              ruleOptions.principalKind = policyContext.principal.kind;
            }
            if (policyContext.principal.id != null) {
              ruleOptions.principalId = policyContext.principal.id;
            }
            if (policyContext.principal.version != null) {
              ruleOptions.principalVersion = policyContext.principal.version;
            }
          }
          if (policyContext?.executionTarget != null) {
            ruleOptions.executionTarget = policyContext.executionTarget;
          }

          const hasOptions = Object.keys(ruleOptions).length > 0;
          addRule(name, response.selectedPattern, response.selectedScope, 'allow', 100, hasOptions ? ruleOptions : undefined);
        }
      }

      const hookResult = await getHookManager().trigger('pre-tool-execute', {
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
          type: 'error',
          toolName: name,
          executionTarget,
          input,
          workingDir: context.workingDir,
          sessionId: context.sessionId,
          conversationId: context.conversationId,
          requestId: context.requestId,
          riskLevel,
          decision: 'blocked',
          durationMs,
          errorMessage: msg,
          isExpected: true,
          errorCategory: 'tool_failure',
        });
        return { content: msg, isError: true };
      }

      // Execute the tool — proxy tools delegate to an external resolver
      let execResult: ToolExecutionResult;
      const rawTimeoutSec = tool.timeoutSec ?? getConfig().timeouts.toolExecutionTimeoutSec;
      const toolTimeoutMs = safeTimeoutMs(rawTimeoutSec);

      // Enrich context with principal so tools (e.g. claude_code) can
      // forward it through sub-tool confirmation requests.
      const execContext = policyContext?.principal
        ? { ...context, principal: policyContext.principal }
        : context;

      if (tool.executionMode === 'proxy') {
        if (!context.proxyToolResolver) {
          const msg = `No proxy resolver configured for proxy tool "${name}". This tool requires an external resolver (e.g. a connected macOS client for computer-use tools).`;
          const durationMs = Date.now() - startTime;
          emitLifecycleEvent(context, {
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

      // Secret detection on tool output
      const sdConfig = getConfig().secretDetection;
      if (sdConfig.enabled && !execResult.isError) {
        const entropyConfig = { enabled: true, base64Threshold: sdConfig.entropyThreshold };
        const contentMatches = scanText(execResult.content, entropyConfig);
        const diffMatches = execResult.diff
          ? scanText(execResult.diff.newContent, entropyConfig)
          : [];
        const blockMatches = (execResult.contentBlocks ?? []).flatMap((block) => {
          if (block.type === 'text') return scanText(block.text, entropyConfig);
          if (block.type === 'file' && block.extracted_text) return scanText(block.extracted_text, entropyConfig);
          return [];
        });
        const allMatches = [...contentMatches, ...diffMatches, ...blockMatches];

        if (allMatches.length > 0) {
          const matchSummary = allMatches.map((m) => ({
            type: m.type,
            redactedValue: m.redactedValue,
          }));

          emitLifecycleEvent(context, {
            type: 'secret_detected',
            toolName: name,
            executionTarget,
            input,
            workingDir: context.workingDir,
            sessionId: context.sessionId,
            conversationId: context.conversationId,
            requestId: context.requestId,
            matches: matchSummary,
            action: sdConfig.action,
            detectedAtMs: Date.now(),
          });

          if (sdConfig.action === 'redact') {
            execResult.content = redactSecrets(execResult.content, entropyConfig);
            if (execResult.diff) {
              execResult.diff = {
                ...execResult.diff,
                newContent: redactSecrets(execResult.diff.newContent, entropyConfig),
              };
            }
            if (execResult.contentBlocks) {
              execResult.contentBlocks = execResult.contentBlocks.map((block) => {
                if (block.type === 'text') {
                  return { ...block, text: redactSecrets(block.text, entropyConfig) };
                }
                if (block.type === 'file' && block.extracted_text) {
                  return { ...block, extracted_text: redactSecrets(block.extracted_text, entropyConfig) };
                }
                return block;
              });
            }
          } else if (sdConfig.action === 'block') {
            const types = [...new Set(allMatches.map((m) => m.type))].join(', ');
            const blockedContent = `Tool output blocked: detected ${allMatches.length} potential secret(s) (${types}). Configure secretDetection.action to "redact" or "prompt" to allow output.`;
            const durationMs = Date.now() - startTime;
            const blockedResult = {
              content: blockedContent,
              isError: true,
            };
            emitLifecycleEvent(context, {
              type: 'executed',
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
              result: blockedResult,
            });

            void getHookManager().trigger('post-tool-execute', {
              toolName: name,
              input: sanitizeToolInput(name, input),
              riskLevel,
              isError: true,
              durationMs,
              sessionId: context.sessionId,
            });

            return blockedResult;
          } else if (sdConfig.action === 'prompt') {
            // Ask the user whether to allow tool output containing secrets
            const types = [...new Set(allMatches.map((m) => m.type))].join(', ');

            // Non-interactive sessions: auto-block secret output instead of waiting for prompt
            if (context.isInteractive === false) {
              const blockedContent = `Tool output blocked: detected ${allMatches.length} potential secret(s) (${types}). No interactive client available to approve.`;
              const durationMs = Date.now() - startTime;
              log.info({ toolName: name }, 'Auto-blocking secret output for non-interactive session');
              emitLifecycleEvent(context, {
                type: 'permission_denied',
                toolName: name,
                executionTarget,
                input,
                workingDir: context.workingDir,
                sessionId: context.sessionId,
                conversationId: context.conversationId,
                requestId: context.requestId,
                riskLevel: RiskLevel.High,
                decision: 'deny',
                reason: 'Non-interactive session: auto-blocked secret output',
                durationMs,
              });

              void getHookManager().trigger('post-tool-execute', {
                toolName: name,
                input: sanitizeToolInput(name, input),
                riskLevel,
                isError: true,
                durationMs,
                sessionId: context.sessionId,
              });

              return { content: blockedContent, isError: true };
            }

            const promptInput = {
              _secretDetection: true,
              summary: `Tool output contains ${allMatches.length} potential secret(s): ${types}`,
              tool: name,
            };

            emitLifecycleEvent(context, {
              type: 'permission_prompt',
              toolName: name,
              executionTarget,
              input: promptInput,
              workingDir: context.workingDir,
              sessionId: context.sessionId,
              conversationId: context.conversationId,
              requestId: context.requestId,
              riskLevel: RiskLevel.High,
              reason: `Secret detected in tool output: ${types}`,
              allowlistOptions: [],
              scopeOptions: [],
              persistentDecisionsAllowed: false,
            });

            const response = await this.prompter.prompt(
              name,
              promptInput,
              RiskLevel.High,
              [],   // no allowlist options
              [],   // no scope options
              undefined, // no diff
              undefined, // not sandboxed
              context.conversationId,
              executionTarget,
              undefined, // no principal
              false, // no persistent decisions
            );

            if (response.decision === 'deny' || response.decision === 'always_deny') {
              const blockedContent = `Tool output blocked: user denied output containing ${allMatches.length} potential secret(s) (${types}).`;
              const durationMs = Date.now() - startTime;
              emitLifecycleEvent(context, {
                type: 'permission_denied',
                toolName: name,
                executionTarget,
                input,
                workingDir: context.workingDir,
                sessionId: context.sessionId,
                conversationId: context.conversationId,
                requestId: context.requestId,
                riskLevel: RiskLevel.High,
                decision: response.decision === 'always_deny' ? 'always_deny' : 'deny',
                reason: `User denied output containing secrets: ${types}`,
                durationMs,
              });

              void getHookManager().trigger('post-tool-execute', {
                toolName: name,
                input: sanitizeToolInput(name, input),
                riskLevel,
                isError: true,
                durationMs,
                sessionId: context.sessionId,
              });

              return { content: blockedContent, isError: true };
            }
            // User allowed — pass content through unchanged
          }
        }
      }

      const durationMs = Date.now() - startTime;
      emitLifecycleEvent(context, {
        type: 'executed',
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
        result: execResult,
      });

      void getHookManager().trigger('post-tool-execute', {
        toolName: name,
        input: sanitizeToolInput(name, input),
        riskLevel,
        isError: execResult.isError,
        durationMs,
        sessionId: context.sessionId,
      });

      return execResult;
    } catch (err) {
      const durationMs = Date.now() - startTime;
      const msg = err instanceof Error ? err.message : String(err);
      const isExpected = err instanceof PermissionDeniedError || err instanceof ToolError || err instanceof TokenExpiredError;

      const errorCategory = err instanceof PermissionDeniedError
        ? 'permission_denied' as const
        : err instanceof TokenExpiredError
          ? 'auth' as const
          : err instanceof ToolError
            ? 'tool_failure' as const
            : 'unexpected' as const;

      emitLifecycleEvent(context, {
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
        isExpected,
        errorCategory,
        errorName: err instanceof Error ? err.name : undefined,
        errorStack: err instanceof Error ? err.stack : undefined,
      });

      void getHookManager().trigger('post-tool-execute', {
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
      return { content: `Tool "${name}" encountered an unexpected error: ${msg}`, isError: true };
    }
  }
}

// ── Side-effect tool classifier ─────────────────────────────────────
// Tools that modify state outside the assistant (filesystem writes,
// shell commands, network requests that trigger actions, etc.).
// Used by private-thread gating to decide whether a tool invocation
// should be blocked in a read-only thread context.

const SIDE_EFFECT_TOOLS: ReadonlySet<string> = new Set([
  'file_write',
  'file_edit',
  'host_file_write',
  'host_file_edit',
  'bash',
  'host_bash',
  'web_fetch',
  'browser_navigate',
  'browser_click',
  'browser_type',
  'browser_press_key',
  'browser_close',
  'browser_fill_credential',
  'document_create',
  'document_update',
  'reminder_create',
  'reminder_cancel',
  'schedule_create',
  'schedule_update',
  'schedule_delete',
]);

/**
 * Returns `true` if the given tool name is classified as having side effects
 * (i.e. it can modify the filesystem, execute arbitrary commands, or trigger
 * external actions). Read-only and informational tools return `false`.
 *
 * For mixed-action tools (e.g. account_manage, reminder), the optional
 * `input` parameter is inspected to distinguish mutating actions (create,
 * update, cancel) from read-only ones (list, get).
 */
export function isSideEffectTool(toolName: string, input?: Record<string, unknown>): boolean {
  if (SIDE_EFFECT_TOOLS.has(toolName)) return true;

  // Action-aware checks for mixed-action tools
  if (toolName === 'account_manage') {
    const action = input?.action;
    return action === 'create' || action === 'update';
  }
  if (toolName === 'credential_store') {
    const action = input?.action;
    return action === 'store' || action === 'delete' || action === 'prompt' || action === 'oauth2_connect';
  }

  return false;
}

const TIMEOUT_SENTINEL = Symbol('tool-timeout');

const DEFAULT_TOOL_TIMEOUT_SEC = 120;

/**
 * Convert a config-provided seconds value to a safe milliseconds value,
 * falling back to the default if the input is NaN, non-finite, zero, or negative.
 */
function safeTimeoutMs(sec: unknown): number {
  const n = Number(sec);
  if (!Number.isFinite(n) || n <= 0) {
    return DEFAULT_TOOL_TIMEOUT_SEC * 1000;
  }
  return n * 1000;
}

/**
 * Race a tool execution promise against a timeout. Returns a timeout error
 * result instead of throwing so the agent loop can continue gracefully.
 */
async function executeWithTimeout(
  promise: Promise<ToolExecutionResult>,
  timeoutMs: number,
  toolName: string,
): Promise<ToolExecutionResult> {
  // Guard against NaN/invalid values that would cause setTimeout to fire immediately
  const safeMs = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : DEFAULT_TOOL_TIMEOUT_SEC * 1000;
  let timeoutHandle: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<typeof TIMEOUT_SENTINEL>((resolve) => {
    timeoutHandle = setTimeout(() => resolve(TIMEOUT_SENTINEL), safeMs);
  });
  try {
    const result = await Promise.race([promise, timeoutPromise]);
    if (result === TIMEOUT_SENTINEL) {
      const sec = Math.round(safeMs / 1000);
      return {
        content: `Tool "${toolName}" timed out after ${sec}s. The operation may still be running in the background. Consider increasing timeouts.toolExecutionTimeoutSec in the config.`,
        isError: true,
      };
    }
    return result;
  } finally {
    clearTimeout(timeoutHandle!);
  }
}

/**
 * Build a PolicyContext from tool metadata and execution context. Skill-origin
 * tools carry a principal identifying the owning skill. When executing within
 * a task run, ephemeral permission rules are included so pre-approved tools
 * are auto-allowed without prompting.
 */
function buildPolicyContext(tool: Tool, context?: ToolContext): PolicyContext | undefined {
  const ephemeralRules = context?.taskRunId
    ? getTaskRunRules(context.taskRunId)
    : undefined;

  if (tool.origin === 'skill') {
    return {
      principal: {
        kind: 'skill',
        id: tool.ownerSkillId,
        version: tool.ownerSkillVersionHash,
      },
      executionTarget: tool.executionTarget,
      ephemeralRules: ephemeralRules?.length ? ephemeralRules : undefined,
    };
  }

  // For non-skill tools in a task run, create a context with task principal
  // and ephemeral rules so pre-approved tools are honored.
  if (context?.taskRunId && ephemeralRules?.length) {
    return {
      principal: {
        kind: 'task',
        id: context.taskRunId,
      },
      ephemeralRules,
    };
  }

  return undefined;
}

function resolveExecutionTarget(toolName: string): ExecutionTarget {
  const tool = getTool(toolName);
  // Manifest-declared execution target is authoritative — check it first so
  // skill tools with host_/computer_use_ prefixes aren't mis-classified.
  if (tool?.executionTarget) {
    return tool.executionTarget;
  }
  // Check the tool's executionMode metadata — proxy tools run on the connected
  // client (host), not inside the sandbox.
  if (tool?.executionMode === 'proxy') {
    return 'host';
  }
  // Prefix heuristics for core tools that don't declare an explicit target.
  if (toolName.startsWith('host_') || toolName.startsWith('computer_use_')) {
    return 'host';
  }
  return 'sandbox';
}

/**
 * Sanitize tool inputs before they are emitted in lifecycle events and hooks.
 * Applies recursive field-level redaction for known-sensitive keys.
 */
function sanitizeToolInput(_toolName: string, input: Record<string, unknown>): Record<string, unknown> {
  return redactSensitiveFields(input);
}

function emitLifecycleEvent(context: ToolContext, event: ToolLifecycleEvent): void {
  const handler = context.onToolLifecycleEvent;
  if (!handler) return;

  // Redact sensitive fields from tool inputs before they reach audit listeners
  const sanitizedEvent = { ...event, input: sanitizeToolInput(event.toolName, event.input) };

  try {
    const maybePromise = handler(sanitizedEvent as ToolLifecycleEvent);
    if (maybePromise) {
      void maybePromise.catch((err) => {
        log.warn(
          { err, eventType: event.type, toolName: event.toolName },
          'Tool lifecycle event handler failed (non-fatal, tool execution was not affected)',
        );
      });
    }
  } catch (err) {
    log.warn(
      { err, eventType: event.type, toolName: event.toolName },
      'Tool lifecycle event handler failed (non-fatal, tool execution was not affected)',
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
): { filePath: string; oldContent: string; newContent: string; isNewFile: boolean } | undefined {
  try {
    if (toolName === 'file_write') {
      const rawPath = input.path as string;
      const content = input.content as string;
      if (!rawPath || typeof content !== 'string') return undefined;
      const pathCheck = sandboxPolicy(rawPath, workingDir, { mustExist: false });
      if (!pathCheck.ok) return undefined;
      const filePath = pathCheck.resolved;
      const isNewFile = !existsSync(filePath);
      if (!isNewFile) {
        const stat = statSync(filePath);
        if (stat.size > MAX_FILE_SIZE_BYTES) return undefined;
      }
      const oldContent = isNewFile ? '' : readFileSync(filePath, 'utf-8');
      return { filePath, oldContent, newContent: content, isNewFile };
    }

    if (toolName === 'file_edit') {
      const rawPath = input.path as string;
      const oldString = input.old_string as string;
      const newString = input.new_string as string;
      if (!rawPath || typeof oldString !== 'string' || typeof newString !== 'string' || oldString.length === 0) return undefined;
      const pathCheck = sandboxPolicy(rawPath, workingDir);
      if (!pathCheck.ok) return undefined;
      const filePath = pathCheck.resolved;
      if (!existsSync(filePath)) return undefined;
      const stat = statSync(filePath);
      if (stat.size > MAX_FILE_SIZE_BYTES) return undefined;
      const content = readFileSync(filePath, 'utf-8');
      const replaceAll = input.replace_all === true;
      const result = applyEdit(content, oldString, newString, replaceAll);
      if (!result.ok) return undefined;
      return { filePath, oldContent: content, newContent: result.updatedContent, isNewFile: false };
    }
  } catch {
    // Preview is best-effort — don't block the prompt on errors
  }
  return undefined;
}
