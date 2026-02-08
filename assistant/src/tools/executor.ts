import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { getTool } from './registry.js';
import type { ToolContext, ToolExecutionResult } from './types.js';
import { RiskLevel } from '../permissions/types.js';
import { check, classifyRisk, generateAllowlistOptions, generateScopeOptions } from '../permissions/checker.js';
import { addRule } from '../permissions/trust-store.js';
import { PermissionPrompter } from '../permissions/prompter.js';
import { recordToolInvocation } from '../memory/tool-usage-store.js';
import { ToolError, PermissionDeniedError } from '../util/errors.js';
import { getLogger } from '../util/logger.js';
import { findAllMatches, adjustIndentation } from './filesystem/fuzzy-match.js';

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
    const tool = getTool(name);
    if (!tool) {
      return { content: `Unknown tool: ${name}`, isError: true };
    }

    const startTime = Date.now();
    let decision = 'allow';
    let riskLevel: string = RiskLevel.Low;

    try {
      // Check permissions
      const risk = await classifyRisk(name, input);
      riskLevel = risk;
      const result = await check(name, input, context.workingDir);

      if (result.decision === 'deny') {
        decision = 'denied';
        const durationMs = Date.now() - startTime;
        recordToolInvocation({
          conversationId: context.conversationId,
          toolName: name,
          input: JSON.stringify(input),
          result: `denied: ${result.reason}`,
          decision: 'denied',
          riskLevel,
          durationMs,
        });
        return { content: result.reason, isError: true };
      }

      if (result.decision === 'prompt') {
        // Need user approval
        const allowlistOptions = generateAllowlistOptions(name, input);
        const scopeOptions = generateScopeOptions(context.workingDir);

        // Compute preview diff for file tools so the user sees what will change
        const previewDiff = computePreviewDiff(name, input, context.workingDir);

        const response = await this.prompter.prompt(
          name,
          input,
          riskLevel,
          allowlistOptions,
          scopeOptions,
          previewDiff,
        );

        decision = response.decision;

        if (response.decision === 'deny') {
          const durationMs = Date.now() - startTime;
          recordToolInvocation({
            conversationId: context.conversationId,
            toolName: name,
            input: JSON.stringify(input),
            result: 'denied',
            decision: 'denied',
            riskLevel,
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
          recordToolInvocation({
            conversationId: context.conversationId,
            toolName: name,
            input: JSON.stringify(input),
            result: ruleSaved ? 'denied (permanent)' : 'denied',
            decision: 'denied',
            riskLevel,
            durationMs,
          });
          return { content: ruleSaved ? 'Permission denied by user (rule saved)' : 'Permission denied by user', isError: true };
        }

        if (response.decision === 'always_allow' && response.selectedPattern && response.selectedScope) {
          addRule(name, response.selectedPattern, response.selectedScope);
        }
      }

      // Execute the tool
      const execResult = await tool.execute(input, context);

      const durationMs = Date.now() - startTime;
      recordToolInvocation({
        conversationId: context.conversationId,
        toolName: name,
        input: JSON.stringify(input),
        result: execResult.content.slice(0, 1000), // Truncate for storage
        decision,
        riskLevel,
        durationMs,
      });

      return execResult;
    } catch (err) {
      const durationMs = Date.now() - startTime;
      const msg = err instanceof Error ? err.message : String(err);

      recordToolInvocation({
        conversationId: context.conversationId,
        toolName: name,
        input: JSON.stringify(input),
        result: `error: ${msg}`,
        decision: 'error',
        riskLevel,
        durationMs,
      });

      if (err instanceof PermissionDeniedError || err instanceof ToolError) {
        return { content: msg, isError: true };
      }

      log.error({ err, name }, 'Tool execution error');
      return { content: `Tool error: ${msg}`, isError: true };
    }
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
      const filePath = resolve(workingDir, rawPath);
      const isNewFile = !existsSync(filePath);
      const oldContent = isNewFile ? '' : readFileSync(filePath, 'utf-8');
      return { filePath, oldContent, newContent: content, isNewFile };
    }

    if (toolName === 'file_edit') {
      const rawPath = input.path as string;
      const oldString = input.old_string as string;
      const newString = input.new_string as string;
      if (!rawPath || typeof oldString !== 'string' || typeof newString !== 'string') return undefined;
      const filePath = resolve(workingDir, rawPath);
      if (!existsSync(filePath)) return undefined;
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
