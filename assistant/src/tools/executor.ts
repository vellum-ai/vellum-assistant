import { readFileSync, existsSync, statSync } from 'node:fs';
import { getTool, getAllTools } from './registry.js';
import type { ExecutionTarget, ToolContext, ToolExecutionResult, ToolLifecycleEvent } from './types.js';
import { RiskLevel } from '../permissions/types.js';
import { check, classifyRisk, generateAllowlistOptions, generateScopeOptions } from '../permissions/checker.js';
import { addRule } from '../permissions/trust-store.js';
import { PermissionPrompter } from '../permissions/prompter.js';
import { ToolError, PermissionDeniedError } from '../util/errors.js';
import { getLogger } from '../util/logger.js';
import { findAllMatches, adjustIndentation } from './filesystem/fuzzy-match.js';
import { validateFilePath } from './filesystem/path-guard.js';
import { MAX_FILE_SIZE_BYTES } from './filesystem/size-guard.js';
import { wrapCommand } from './terminal/sandbox.js';
import { getConfig } from '../config/loader.js';
import { scanText, redactSecrets } from '../security/secret-scanner.js';
import { getHookManager } from '../hooks/manager.js';

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
      });
      return { content: msg, isError: true };
    }

    try {
      // Check permissions
      const risk = await classifyRisk(name, input);
      riskLevel = risk;
      const result = await check(name, input, context.workingDir);

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
        // Need user approval
        const allowlistOptions = generateAllowlistOptions(name, input);
        const scopeOptions = generateScopeOptions(context.workingDir, name);

        // Compute preview diff for file tools so the user sees what will change
        const previewDiff = computePreviewDiff(name, input, context.workingDir);

        let sandboxed: boolean | undefined;
        if (name === 'bash' && typeof input.command === 'string') {
          const sandboxEnabled = context.sandboxOverride ?? getConfig().sandbox.enabled;
          const wrapped = wrapCommand(input.command, context.workingDir, sandboxEnabled);
          sandboxed = wrapped.sandboxed;
        }

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
        });

        void getHookManager().trigger('permission-request', {
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
        );

        decision = response.decision;

        void getHookManager().trigger('permission-resolve', {
          toolName: name,
          decision: response.decision,
          riskLevel,
          sessionId: context.sessionId,
        });

        if (response.decision === 'deny') {
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
          return { content: 'Permission denied by user', isError: true };
        }

        if (response.decision === 'always_deny') {
          const ruleSaved = !!(response.selectedPattern && response.selectedScope);
          if (ruleSaved) {
            addRule(name, response.selectedPattern!, response.selectedScope!, 'deny');
          }
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
            reason: ruleSaved ? 'Permission denied by user (rule saved)' : 'Permission denied by user',
            durationMs,
          });
          return { content: ruleSaved ? 'Permission denied by user (rule saved)' : 'Permission denied by user', isError: true };
        }

        if (response.decision === 'always_allow' && response.selectedPattern && response.selectedScope) {
          addRule(name, response.selectedPattern, response.selectedScope);
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
        });
        return { content: msg, isError: true };
      }

      // Execute the tool — proxy tools delegate to an external resolver
      let execResult: ToolExecutionResult;
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
          });
          return { content: msg, isError: true };
        }
        execResult = await context.proxyToolResolver(name, input);
      } else {
        execResult = await tool.execute(input, context);
      }

      // Secret detection on tool output
      const sdConfig = getConfig().secretDetection;
      if (sdConfig.enabled && !execResult.isError) {
        const entropyConfig = { enabled: true, base64Threshold: sdConfig.entropyThreshold };
        const contentMatches = scanText(execResult.content, entropyConfig);
        const diffMatches = execResult.diff
          ? scanText(execResult.diff.newContent, entropyConfig)
          : [];
        const allMatches = [...contentMatches, ...diffMatches];

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
          } else if (sdConfig.action === 'block') {
            const types = [...new Set(allMatches.map((m) => m.type))].join(', ');
            const blockedContent = `Tool output blocked: detected ${allMatches.length} potential secret(s) (${types}). Configure secretDetection.action to "redact" or "warn" to allow output.`;
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
      const isExpected = err instanceof PermissionDeniedError || err instanceof ToolError;

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

function resolveExecutionTarget(toolName: string): ExecutionTarget {
  if (toolName.startsWith('host_') || toolName.startsWith('cu_') || toolName === 'request_computer_control') {
    return 'host';
  }
  // Check the tool's executionMode metadata — proxy tools run on the connected
  // client (host), not inside the sandbox.
  const tool = getTool(toolName);
  if (tool?.executionMode === 'proxy') {
    return 'host';
  }
  return 'sandbox';
}

/**
 * Sanitize tool inputs before they are emitted in lifecycle events.
 * This prevents plaintext secrets (e.g. credential_store `value`) from
 * being persisted in audit logs.
 */
function sanitizeToolInput(toolName: string, input: Record<string, unknown>): Record<string, unknown> {
  if (toolName === 'credential_store' && 'value' in input) {
    const { value: _redacted, ...rest } = input;
    return { ...rest, value: '<redacted />' };
  }
  return input;
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
      const pathCheck = validateFilePath(rawPath, workingDir, { mustExist: false });
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
      const pathCheck = validateFilePath(rawPath, workingDir);
      if (!pathCheck.ok) return undefined;
      const filePath = pathCheck.resolved;
      if (!existsSync(filePath)) return undefined;
      const stat = statSync(filePath);
      if (stat.size > MAX_FILE_SIZE_BYTES) return undefined;
      const content = readFileSync(filePath, 'utf-8');
      const replaceAll = input.replace_all === true;
      let updated: string;
      if (replaceAll) {
        if (!content.includes(oldString)) return undefined;
        updated = content.split(oldString).join(newString);
      } else {
        const matches = findAllMatches(content, oldString);
        if (matches.length !== 1) return undefined;
        const match = matches[0];
        const adjustedNewString = match.method !== 'exact'
          ? adjustIndentation(oldString, match.matched, newString)
          : newString;
        updated = content.slice(0, match.start) + adjustedNewString + content.slice(match.end);
      }
      return { filePath, oldContent: content, newContent: updated, isNewFile: false };
    }
  } catch {
    // Preview is best-effort — don't block the prompt on errors
  }
  return undefined;
}
