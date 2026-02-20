import { RiskLevel } from '../../permissions/types.js';
import type { Tool, ToolContext, ToolExecutionResult } from '../types.js';
import type { ToolDefinition } from '../../providers/types.js';
import { getConfig } from '../../config/loader.js';
import { getLogger } from '../../util/logger.js';
import { truncate } from '../../util/truncate.js';
import { getProfilePolicy } from '../../swarm/worker-backend.js';
import type { WorkerProfile } from '../../swarm/worker-backend.js';

const log = getLogger('claude-code-tool');

// Tools passed to the SDK's allowedTools list (hints for the subprocess).
const ALLOWED_TOOLS = new Set([
  'Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch',
  'LS', 'Task', 'Bash(grep *)', 'Bash(rg *)', 'Bash(find *)',
]);

const VALID_PROFILES: readonly WorkerProfile[] = ['general', 'researcher', 'coder', 'reviewer', 'worker'];

// Maximum nesting depth for Claude Code subprocesses.
// Depth 0 = top-level assistant, depth 1 = first subprocess, etc.
const MAX_CLAUDE_CODE_DEPTH = 1;
const DEPTH_ENV_VAR = 'VELLUM_CLAUDE_CODE_DEPTH';

function summarizeToolInput(toolName: string, input: Record<string, unknown>): string {
  // Extract the most relevant field for each tool type
  const name = toolName.toLowerCase();
  if (name === 'bash') return String(input.command ?? '');
  if (name === 'read' || name === 'file_read') return String(input.file_path ?? input.path ?? '');
  if (name === 'edit' || name === 'file_edit') return String(input.file_path ?? input.path ?? '');
  if (name === 'write' || name === 'file_write') return String(input.file_path ?? input.path ?? '');
  if (name === 'glob') return String(input.pattern ?? '');
  if (name === 'grep') return String(input.pattern ?? '');
  if (name === 'websearch' || name === 'web_search') return String(input.query ?? '');
  if (name === 'webfetch' || name === 'web_fetch') return String(input.url ?? '');
  if (name === 'task') return String(input.description ?? '');
  // Fallback: first string value
  for (const val of Object.values(input)) {
    if (typeof val === 'string' && val.length > 0 && val.length < 200) return val;
  }
  return '';
}

export const claudeCodeTool: Tool = {
  name: 'claude_code',
  description: 'Delegate a coding task to Claude Code, an AI-powered coding agent that can read, write, and edit files, run shell commands, and perform complex multi-step software engineering tasks autonomously.',
  category: 'coding',
  defaultRiskLevel: RiskLevel.Medium,
  timeoutSec: 600,

  getDefinition(): ToolDefinition {
    return {
      name: 'claude_code',
      description: this.description,
      input_schema: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description: 'The coding task or question for Claude Code to work on (mutually exclusive with command)',
          },
          command: {
            type: 'string',
            description: 'Name of a .claude/commands/*.md command to execute (mutually exclusive with prompt)',
          },
          arguments: {
            type: 'string',
            description: 'Arguments to substitute for $ARGUMENTS in the command template',
          },
          template_vars: {
            type: 'object',
            description: 'Optional key-value pairs to substitute in the command template (e.g., {{key}} patterns)',
            additionalProperties: { type: 'string' },
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
            description: 'Model to use (defaults to claude-sonnet-4-6)',
          },
          max_turns: {
            type: 'number',
            description: 'Maximum number of agentic turns (API round-trips) before stopping. Defaults to 50.',
          },
          profile: {
            type: 'string',
            enum: ['general', 'researcher', 'coder', 'reviewer', 'worker'],
            description: 'Worker profile that scopes tool access. Defaults to general (backward compatible).',
          },
        },
        required: [],
      },
    };
  },

  async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolExecutionResult> {
    if (context.signal?.aborted) {
      return { content: 'Cancelled', isError: true };
    }

    const prompt = input.prompt as string | undefined;
    const command = input.command as string | undefined;
    const args = input.arguments as string | undefined;
    const templateVars = input.template_vars as Record<string, string> | undefined;

    // Validate one-of: exactly one of prompt or command
    if (prompt && command) {
      return {
        content: 'Error: Cannot specify both "prompt" and "command". Use one or the other.',
        isError: true,
      };
    }
    if (!prompt && !command) {
      return {
        content: 'Error: Must specify either "prompt" or "command".',
        isError: true,
      };
    }

    const workingDir = (input.working_dir as string) || context.workingDir;
    const resumeSessionId = input.resume as string | undefined;
    const model = (input.model as string) || 'claude-sonnet-4-6';
    const maxTurns = typeof input.max_turns === 'number' && input.max_turns > 0 ? input.max_turns : 50;
    const profileName = (input.profile as WorkerProfile | undefined) ?? 'general';

    // Validate profile
    if (!VALID_PROFILES.includes(profileName)) {
      return {
        content: `Error: Invalid profile "${profileName}". Valid profiles: ${VALID_PROFILES.join(', ')}.`,
        isError: true,
      };
    }

    const profilePolicy = getProfilePolicy(profileName);

    // Resolve prompt from command template if needed
    let resolvedPrompt: string;

    if (command) {
      // Validate command name: basename-only, no path traversal
      if (command.includes('/') || command.includes('\\') || command.includes('..')) {
        return {
          content: `Error: Invalid command name "${command}". Command names must not contain path separators.`,
          isError: true,
        };
      }
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(command)) {
        return {
          content: `Error: Invalid command name "${command}". Must match pattern: alphanumeric start, then alphanumeric/dot/underscore/hyphen.`,
          isError: true,
        };
      }

      // Import and use CC command registry
      const { getCCCommand, loadCCCommandTemplate, discoverCCCommands } = await import('../../commands/cc-command-registry.js');

      const entry = getCCCommand(workingDir, command);
      if (!entry) {
        const registry = discoverCCCommands(workingDir);
        const available = Array.from(registry.entries.values()).map(e => e.name).sort();
        const availableList = available.length > 0
          ? `\nAvailable commands: ${available.join(', ')}`
          : '\nNo commands found in .claude/commands/';
        return {
          content: `Error: Command "${command}" not found in .claude/commands/.${availableList}`,
          isError: true,
        };
      }

      // Load full template
      let template: string;
      try {
        template = loadCCCommandTemplate(entry);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: `Error: Failed to load command template "${command}": ${message}`,
          isError: true,
        };
      }

      // Substitute $ARGUMENTS
      resolvedPrompt = template.replace(/\$ARGUMENTS/g, args ?? '');

      // Substitute template_vars: {{key}} patterns
      if (templateVars) {
        for (const [key, value] of Object.entries(templateVars)) {
          const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          resolvedPrompt = resolvedPrompt.replace(new RegExp(`\\{\\{${escaped}\\}\\}`, 'g'), value);
        }
      }

      log.info({ command, workingDir, hasArgs: !!args }, 'Executing Claude Code command from template');
    } else {
      resolvedPrompt = prompt!;
    }

    // If the project has .claude/commands/, hint the subprocess so it can discover them
    try {
      const { discoverCCCommands } = await import('../../commands/cc-command-registry.js');
      const registry = discoverCCCommands(workingDir);
      if (registry.entries.size > 0) {
        resolvedPrompt += '\n\nNote: Custom project commands are available in .claude/commands/. Use Glob to list them and Read to view their instructions.';
      }
    } catch {
      // Non-fatal — skip hint if discovery fails
    }

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

    // Collect stderr output from the Claude Code subprocess for debugging
    const stderrLines: string[] = [];

    log.info({ prompt: truncate(resolvedPrompt, 100, ''), workingDir, model, resume: !!resumeSessionId }, 'Starting Claude Code session');

    // Build the canUseTool callback with 5-tier permission logic:
    // 1. deny-list → block  2. allow-list → auto-approve  3. approvalRequired → bubble up or fast-deny  4. default → allow
    const canUseTool: import('@anthropic-ai/claude-agent-sdk').CanUseTool = async (toolName) => {
      // 1. Deny-list: block unconditionally
      if (profilePolicy.deny.has(toolName)) {
        log.debug({ toolName, profile: profileName }, 'Tool denied by profile policy');
        return { behavior: 'deny' as const, message: `Tool "${toolName}" is denied by profile "${profileName}"` };
      }
      // 2. Allow-list: auto-approve
      if (profilePolicy.allow.has(toolName)) {
        log.debug({ toolName, profile: profileName }, 'Tool auto-allowed by profile policy');
        return { behavior: 'allow' as const };
      }
      // 3. Approval-required: bubble up to user or fast-deny when non-interactive
      if (profilePolicy.approvalRequired.has(toolName)) {
        if (context.requestConfirmation) {
          log.debug({ toolName, profile: profileName }, 'Bubbling up tool approval to user');
          const result = await context.requestConfirmation({
            toolName,
            input: {},
            riskLevel: 'medium',
            principal: context.principal,
          });
          log.debug({ toolName, decision: result.decision }, 'User permission decision');
          return { behavior: result.decision === 'allow' ? 'allow' as const : 'deny' as const };
        }
        // Non-interactive: fast-deny
        if (!context.isInteractive) {
          log.debug({ toolName, profile: profileName }, 'Tool requires approval but session is non-interactive');
          return { behavior: 'deny' as const, message: `Tool "${toolName}" requires approval but session is non-interactive` };
        }
      }
      // 4. Default: allow (backward compat for tools not in any set)
      return { behavior: 'allow' as const };
    };

    // Enforce nesting depth limit to prevent infinite recursion.
    const currentDepth = parseInt(process.env[DEPTH_ENV_VAR] ?? '0', 10);
    if (currentDepth >= MAX_CLAUDE_CODE_DEPTH) {
      log.warn({ currentDepth, max: MAX_CLAUDE_CODE_DEPTH }, 'Claude Code nesting depth exceeded');
      return {
        content: `Error: Claude Code nesting depth exceeded (depth ${currentDepth}, max ${MAX_CLAUDE_CODE_DEPTH}). Cannot spawn another Claude Code subprocess.`,
        isError: true,
      };
    }

    // Build a clean env for the subprocess. Strip the SDK's own nesting guard
    // (CLAUDECODE) so it can launch, but set our depth counter to enforce our limit.
    const subprocessEnv: Record<string, string | undefined> = {
      ...process.env,
      ANTHROPIC_API_KEY: apiKey,
      [DEPTH_ENV_VAR]: String(currentDepth + 1),
    };
    delete subprocessEnv.CLAUDECODE;
    delete subprocessEnv.CLAUDE_CODE_ENTRYPOINT;

    // Build query options
    const queryOptions: import('@anthropic-ai/claude-agent-sdk').Options = {
      cwd: workingDir,
      model,
      canUseTool,
      permissionMode: 'default',
      allowedTools: [...ALLOWED_TOOLS],
      env: subprocessEnv,
      maxTurns,
      persistSession: true,
      stderr: (data: string) => {
        const trimmed = data.trimEnd();
        if (trimmed) {
          stderrLines.push(trimmed);
          log.debug({ stderr: trimmed }, 'Claude Code subprocess stderr');
        }
      },
    };

    if (resumeSessionId) {
      queryOptions.resume = resumeSessionId;
    }

    // Declared outside try so the catch block can emit a final tool_complete on error.
    let lastSubToolName: string | null = null;
    let activeToolUseId: string | null = null;

    try {
      const conversation = query({ prompt: resolvedPrompt, options: queryOptions });
      let resultText = '';
      let sessionId = '';
      let hasError = false;

      // Track tool_use_id → {name, inputSummary} for enriching progress events.
      const toolUseIdInfo = new Map<string, { name: string; inputSummary: string }>();
      // Track tool_use_ids that we've already emitted tool_start for (to avoid duplicates).
      const emittedToolUseIds = new Set<string>();

      for await (const message of conversation) {
        switch (message.type) {
          case 'assistant': {
            // Check for SDK-level errors on the assistant message
            if (message.error) {
              log.error({ error: message.error, sessionId: message.session_id }, 'Claude Code assistant message error');
              hasError = true;
              resultText += `\n\n[Claude Code error: ${message.error}]`;
            }
            // Extract text from assistant messages
            if (message.message?.content) {
              for (const block of message.message.content) {
                if (block.type === 'text') {
                  context.onOutput?.(block.text);
                  resultText += block.text;
                }
                if (block.type === 'tool_use') {
                  // Capture info keyed by tool_use_id for enriching tool_progress events.
                  const inputSummary = summarizeToolInput(block.name, block.input as Record<string, unknown>);
                  toolUseIdInfo.set(block.id, { name: block.name, inputSummary });

                  // Emit tool_start if we haven't already (tool_progress may have fired first).
                  // NOTE: Do NOT emit tool_complete for the previous tool here. An assistant
                  // message may contain multiple tool_use blocks (parallel tool use) and none
                  // of them have executed yet at this point. Completions are handled by
                  // tool_use_summary and tool_progress events.
                  if (!emittedToolUseIds.has(block.id)) {
                    context.onOutput?.(JSON.stringify({
                      subType: 'tool_start',
                      subToolName: block.name,
                      subToolInput: inputSummary,
                      subToolId: block.id,
                    }));
                    emittedToolUseIds.add(block.id);
                    lastSubToolName = block.name;
                    activeToolUseId = block.id;
                  }
                }
              }
            }
            sessionId = message.session_id;
            break;
          }
          case 'tool_progress': {
            // The SDK fires tool_progress periodically DURING tool execution.
            // This is our primary signal for live sub-tool progress.
            const toolUseId = message.tool_use_id;
            const toolName = message.tool_name;
            sessionId = message.session_id;

            // Record tool name if we don't have it yet (tool_progress fires before assistant sometimes).
            if (!toolUseIdInfo.has(toolUseId)) {
              toolUseIdInfo.set(toolUseId, { name: toolName, inputSummary: '' });
            }

            if (!emittedToolUseIds.has(toolUseId)) {
              // New tool — mark previous as complete and emit tool_start.
              if (lastSubToolName && activeToolUseId !== toolUseId) {
                context.onOutput?.(JSON.stringify({
                  subType: 'tool_complete',
                  subToolName: lastSubToolName,
                  subToolId: activeToolUseId,
                }));
              }
              const inputSummary = toolUseIdInfo.get(toolUseId)?.inputSummary ?? '';
              context.onOutput?.(JSON.stringify({
                subType: 'tool_start',
                subToolName: toolName,
                subToolInput: inputSummary,
                subToolId: toolUseId,
              }));
              emittedToolUseIds.add(toolUseId);
              lastSubToolName = toolName;
            }
            activeToolUseId = toolUseId;
            break;
          }
          case 'tool_use_summary': {
            // The SDK fires tool_use_summary after tool execution with a summary
            // and the IDs of tools that were executed.
            sessionId = message.session_id;
            for (const completedId of message.preceding_tool_use_ids) {
              const info = toolUseIdInfo.get(completedId);
              const completedName: string | null = info?.name ?? lastSubToolName;
              if (completedName && emittedToolUseIds.has(completedId)) {
                context.onOutput?.(JSON.stringify({
                  subType: 'tool_complete',
                  subToolName: completedName,
                  subToolId: completedId,
                }));
                if (lastSubToolName === completedName) {
                  lastSubToolName = null;
                }
              }
              // Prune completed entries to keep memory flat across long sessions.
              toolUseIdInfo.delete(completedId);
              emittedToolUseIds.delete(completedId);
            }
            activeToolUseId = null;
            break;
          }
          case 'result': {
            // Mark the final sub-tool as complete (flag error if the session failed).
            if (lastSubToolName) {
              const isFailure = message.subtype !== 'success';
              context.onOutput?.(JSON.stringify({
                subType: 'tool_complete',
                subToolName: lastSubToolName,
                subToolId: activeToolUseId,
                ...(isFailure && { subToolIsError: true }),
              }));
              lastSubToolName = null;
            }
            sessionId = message.session_id;
            const resultMeta = {
              subtype: message.subtype,
              numTurns: message.num_turns,
              durationMs: message.duration_ms,
              costUsd: message.total_cost_usd,
              stopReason: message.stop_reason,
            };

            if (message.subtype === 'success') {
              log.info(resultMeta, 'Claude Code session completed successfully');
              if (message.result && !resultText) {
                resultText = message.result;
              }
            } else {
              // Error result — surface the subtype and details
              hasError = true;
              const errors = message.errors ?? [];
              const denials = message.permission_denials ?? [];

              log.error({ ...resultMeta, errors, permissionDenials: denials.length }, 'Claude Code session failed');

              const parts: string[] = [];
              parts.push(`[${message.subtype}] (${message.num_turns} turns, ${(message.duration_ms / 1000).toFixed(1)}s)`);
              if (errors.length > 0) {
                parts.push(`Errors: ${errors.join('; ')}`);
              }
              if (denials.length > 0) {
                const denialSummary = denials.map(d => `${d.tool_name}`).join(', ');
                parts.push(`Permission denied: ${denialSummary}`);
              }
              resultText += `\n\n${parts.join('\n')}`;
            }
            break;
          }
          default:
            // Log unhandled message types at debug level for diagnostics
            log.debug({ messageType: message.type }, 'Claude Code unhandled message type');
            break;
        }
      }

      const output = resultText.trim() || 'Claude Code completed without producing text output.';
      const sessionInfo = sessionId ? `\n\n[Claude Code session: ${sessionId}]` : '';

      return {
        content: output + sessionInfo,
        isError: hasError,
      };
    } catch (err) {
      // Mark the last sub-tool as failed so the UI shows an error icon.
      if (lastSubToolName) {
        context.onOutput?.(JSON.stringify({
          subType: 'tool_complete',
          subToolName: lastSubToolName,
          subToolId: activeToolUseId,
          subToolIsError: true,
        }));
        lastSubToolName = null;
      }

      const errMessage = err instanceof Error ? err.message : String(err);
      const recentStderr = stderrLines.slice(-20);
      log.error({ err, stderrTail: recentStderr }, 'Claude Code execution failed');

      const parts = [`Claude Code error: ${errMessage}`];
      if (recentStderr.length > 0) {
        parts.push(`\nSubprocess stderr (last ${recentStderr.length} lines):\n${recentStderr.join('\n')}`);
      }
      return {
        content: parts.join(''),
        isError: true,
      };
    }
  },
};
