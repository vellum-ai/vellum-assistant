import { getTool } from './registry.js';
import type { ToolContext, ToolExecutionResult } from './types.js';
import { RiskLevel } from '../permissions/types.js';
import { check, classifyRisk, generateAllowlistOptions, generateScopeOptions } from '../permissions/checker.js';
import { addRule } from '../permissions/trust-store.js';
import { PermissionPrompter } from '../permissions/prompter.js';
import { recordToolInvocation } from '../memory/tool-usage-store.js';
import { ToolError, PermissionDeniedError } from '../util/errors.js';
import { getLogger } from '../util/logger.js';

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

        const response = await this.prompter.prompt(
          name,
          input,
          riskLevel,
          allowlistOptions,
          scopeOptions,
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
