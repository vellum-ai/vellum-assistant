import { RiskLevel } from '../../permissions/types.js';
import type { Tool, ToolContext, ToolExecutionResult } from '../types.js';
import type { ToolDefinition } from '../../providers/types.js';
import { getConfig } from '../../config/loader.js';
import { getLogger } from '../../util/logger.js';

const log = getLogger('claude-code-tool');

// Tools that CC can use without user approval
const AUTO_APPROVE_TOOLS = new Set([
  'Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch',
  'LS', 'Bash(grep *)', 'Bash(rg *)', 'Bash(find *)',
]);

// Tools that always require user approval via confirmation IPC
const APPROVAL_REQUIRED_TOOLS = new Set([
  'Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit',
]);

export const claudeCodeTool: Tool = {
  name: 'claude_code',
  description: 'Delegate a coding task to Claude Code, an AI-powered coding agent that can read, write, and edit files, run shell commands, and perform complex multi-step software engineering tasks autonomously.',
  category: 'coding',
  defaultRiskLevel: RiskLevel.Medium,

  getDefinition(): ToolDefinition {
    return {
      name: 'claude_code',
      description: this.description,
      input_schema: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description: 'The coding task or question for Claude Code to work on',
          },
          working_dir: {
            type: 'string',
            description: 'Working directory for Claude Code (defaults to session working directory)',
          },
          resume: {
            type: 'string',
            description: 'Claude Code session ID to resume a previous session',
          },
          model: {
            type: 'string',
            description: 'Model to use (defaults to claude-sonnet-4-5-20250929)',
          },
        },
        required: ['prompt'],
      },
    };
  },

  async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolExecutionResult> {
    const prompt = input.prompt as string;
    const workingDir = (input.working_dir as string) || context.workingDir;
    const resumeSessionId = input.resume as string | undefined;
    const model = (input.model as string) || 'claude-sonnet-4-5-20250929';

    // Validate API key
    const config = getConfig();
    const apiKey = config.apiKeys.anthropic ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return {
        content: 'Error: No Anthropic API key configured. Set it via config or ANTHROPIC_API_KEY environment variable.',
        isError: true,
      };
    }

    // Dynamic import of the Agent SDK
    let sdkModule: typeof import('@anthropic-ai/claude-agent-sdk');
    try {
      sdkModule = await import('@anthropic-ai/claude-agent-sdk');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ err }, 'Failed to load Claude Agent SDK');
      return {
        content: `Error: Failed to load Claude Agent SDK: ${message}`,
        isError: true,
      };
    }

    const { query } = sdkModule;

    log.info({ prompt: prompt.slice(0, 100), workingDir, model, resume: !!resumeSessionId }, 'Starting Claude Code session');

    // Build the canUseTool callback
    const canUseTool: import('@anthropic-ai/claude-agent-sdk').CanUseTool = async (toolName, toolInput, _options) => {
      // Auto-approve safe read-only tools
      if (AUTO_APPROVE_TOOLS.has(toolName)) {
        return { behavior: 'allow' as const };
      }

      // For tools that need approval, bridge to Velly's confirmation flow
      if (!context.requestConfirmation) {
        // No confirmation callback available -- deny by default for safety
        log.warn({ toolName }, 'Claude Code tool requires approval but no requestConfirmation callback available');
        return { behavior: 'deny' as const, message: 'Tool approval not available in this context' };
      }

      try {
        const result = await context.requestConfirmation({
          toolName,
          input: toolInput,
          riskLevel: APPROVAL_REQUIRED_TOOLS.has(toolName) ? 'Medium' : 'Low',
        });
        if (result.decision === 'allow') {
          return { behavior: 'allow' as const };
        }
        return { behavior: 'deny' as const, message: `User denied ${toolName}` };
      } catch (err) {
        // Abort/dispose will reject the promise -- treat as deny
        log.debug({ err, toolName }, 'requestConfirmation rejected (likely abort)');
        return { behavior: 'deny' as const, message: 'Approval request cancelled' };
      }
    };

    // Build query options
    const queryOptions: import('@anthropic-ai/claude-agent-sdk').Options = {
      cwd: workingDir,
      model,
      canUseTool,
      permissionMode: 'default',
      allowedTools: [...AUTO_APPROVE_TOOLS],
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: apiKey,
      },
      maxTurns: 50,
      persistSession: true,
    };

    if (resumeSessionId) {
      queryOptions.resume = resumeSessionId;
    }

    try {
      const conversation = query({ prompt, options: queryOptions });
      let resultText = '';
      let sessionId = '';

      for await (const message of conversation) {
        switch (message.type) {
          case 'assistant': {
            // Extract text from assistant messages
            if (message.message?.content) {
              for (const block of message.message.content) {
                if (block.type === 'text') {
                  context.onOutput?.(block.text);
                  resultText += block.text;
                }
              }
            }
            sessionId = message.session_id;
            break;
          }
          case 'result': {
            sessionId = message.session_id;
            if (message.subtype === 'success') {
              if (message.result && !resultText) {
                resultText = message.result;
              }
            } else {
              // Error result
              const errors = message.errors ?? [];
              if (errors.length > 0) {
                resultText += `\n\nErrors: ${errors.join(', ')}`;
              }
            }
            break;
          }
          default:
            // Ignore other message types (system, stream_event, etc.)
            break;
        }
      }

      const output = resultText.trim() || 'Claude Code completed without producing text output.';
      const sessionInfo = sessionId ? `\n\n[Claude Code session: ${sessionId}]` : '';

      return {
        content: output + sessionInfo,
        isError: false,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ err }, 'Claude Code execution failed');
      return {
        content: `Claude Code error: ${message}`,
        isError: true,
      };
    }
  },
};
