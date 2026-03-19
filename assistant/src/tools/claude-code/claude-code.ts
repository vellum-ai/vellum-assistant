import {
  getCCCommand,
  loadCCCommandTemplate,
} from "../../commands/cc-command-registry.js";
import { RiskLevel } from "../../permissions/types.js";
import type { ToolDefinition } from "../../providers/types.js";
import { getProviderKeyAsync } from "../../security/secure-keys.js";
import type { WorkerProfile } from "../../swarm/worker-backend.js";
import { getProfilePolicy } from "../../swarm/worker-backend.js";
import { getLogger } from "../../util/logger.js";
import { truncate } from "../../util/truncate.js";
import type { Tool, ToolContext, ToolExecutionResult } from "../types.js";

const log = getLogger("claude-code-tool");

// Tools that CC can use without user approval
const AUTO_APPROVE_TOOLS = new Set([
  "Read",
  "Glob",
  "Grep",
  "WebSearch",
  "WebFetch",
  "LS",
  "Bash(grep *)",
  "Bash(rg *)",
  "Bash(find *)",
]);

// Tools that always require user approval via confirmation prompt
const APPROVAL_REQUIRED_TOOLS = new Set([
  "Bash",
  "Edit",
  "Write",
  "MultiEdit",
  "NotebookEdit",
]);

const VALID_PROFILES: readonly WorkerProfile[] = [
  "general",
  "researcher",
  "coder",
  "reviewer",
];

// Maximum nesting depth for Claude Code subprocesses.
// Depth 0 = top-level assistant, depth 1 = first subprocess, etc.
const MAX_CLAUDE_CODE_DEPTH = 1;
const DEPTH_ENV_VAR = "VELLUM_CLAUDE_CODE_DEPTH";

function summarizeToolInput(
  toolName: string,
  input: Record<string, unknown>,
): string {
  // Extract the most relevant field for each tool type
  const name = toolName.toLowerCase();
  if (name === "bash") return String(input.command ?? "");
  if (name === "read" || name === "file_read")
    return String(input.file_path ?? input.path ?? "");
  if (name === "edit" || name === "file_edit")
    return String(input.file_path ?? input.path ?? "");
  if (name === "write" || name === "file_write")
    return String(input.file_path ?? input.path ?? "");
  if (name === "glob") return String(input.pattern ?? "");
  if (name === "grep") return String(input.pattern ?? "");
  if (name === "websearch" || name === "web_search")
    return String(input.query ?? "");
  if (name === "webfetch" || name === "web_fetch")
    return String(input.url ?? "");
  if (name === "task") return String(input.description ?? "");
  // Fallback: first string value
  for (const val of Object.values(input)) {
    if (typeof val === "string" && val.length > 0 && val.length < 200)
      return val;
  }
  return "";
}

export const claudeCodeTool: Tool = {
  name: "claude_code",
  description:
    "Delegate a coding task to Claude Code, an AI-powered coding agent that can read, write, and edit files, run shell commands, and perform complex multi-step software engineering tasks autonomously.",
  category: "coding",
  defaultRiskLevel: RiskLevel.Medium,

  getDefinition(): ToolDefinition {
    return {
      name: "claude_code",
      description: this.description,
      input_schema: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            description:
              "The coding task or question for Claude Code to work on. Use this for free-form tasks. Mutually exclusive with command.",
          },
          command: {
            type: "string",
            description:
              "Name of a .claude/commands/*.md command template to execute. The template will be loaded and $ARGUMENTS substituted before execution. Use this instead of prompt when invoking a named CC command.",
          },
          arguments: {
            type: "string",
            description:
              "Arguments to substitute into the command template ($ARGUMENTS placeholder). Only used with the command input.",
          },
          working_dir: {
            type: "string",
            description:
              "Working directory for Claude Code (defaults to conversation working directory)",
          },
          resume: {
            type: "string",
            description: "Claude Code session ID to resume a previous session",
          },
          model: {
            type: "string",
            description: "Model to use (defaults to claude-sonnet-4-6)",
          },
          profile: {
            type: "string",
            enum: ["general", "researcher", "coder", "reviewer"],
            description:
              "Worker profile that scopes tool access. Defaults to general.",
          },
        },
      },
    };
  },

  async execute(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    if (context.signal?.aborted) {
      return { content: "Cancelled", isError: true };
    }

    const workingDir = (input.working_dir as string) || context.workingDir;

    // Resolve prompt: either from direct prompt input or by loading a CC command template
    let prompt: string;
    if (input.command != null && typeof input.command !== "string") {
      return {
        content: `Error: "command" must be a string, got ${typeof input.command}`,
        isError: true,
      };
    }
    const commandName = input.command as string | undefined;
    if (commandName) {
      // Command-template execution path: load .claude/commands/<command>.md,
      // apply $ARGUMENTS substitution, and use the result as the prompt.
      const entry = getCCCommand(workingDir, commandName);
      if (!entry) {
        return {
          content: `Error: CC command "${commandName}" not found. Looked for .claude/commands/${commandName}.md in ${workingDir} and parent directories.`,
          isError: true,
        };
      }

      let template: string;
      try {
        template = loadCCCommandTemplate(entry);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: `Error: Failed to load CC command template "${commandName}": ${message}`,
          isError: true,
        };
      }

      // Substitute $ARGUMENTS placeholder with the provided arguments
      const args = (input.arguments as string) ?? "";
      prompt = template.replace(/\$ARGUMENTS/g, args);

      log.info(
        { command: commandName, templatePath: entry.filePath, hasArgs: !!args },
        "Loaded CC command template",
      );
    } else if (typeof input.prompt === "string") {
      prompt = input.prompt;
    } else {
      return {
        content: 'Error: Either "prompt" or "command" must be provided.',
        isError: true,
      };
    }
    const resumeSessionId = input.resume as string | undefined;
    const model = (input.model as string) || "claude-sonnet-4-6";
    const profileName =
      (input.profile as WorkerProfile | undefined) ?? "general";

    // Validate profile
    if (!VALID_PROFILES.includes(profileName)) {
      return {
        content: `Error: Invalid profile "${profileName}". Valid profiles: ${VALID_PROFILES.join(
          ", ",
        )}.`,
        isError: true,
      };
    }

    const profilePolicy = getProfilePolicy(profileName);

    // Validate API key
    const apiKey = await getProviderKeyAsync("anthropic");
    if (!apiKey) {
      return {
        content:
          "Error: No Anthropic API key configured. Set it via `keys set anthropic <key>` or configure it from the Settings page under API Keys.",
        isError: true,
      };
    }

    // Dynamic import of the Agent SDK
    let sdkModule: typeof import("@anthropic-ai/claude-agent-sdk");
    try {
      sdkModule = await import("@anthropic-ai/claude-agent-sdk");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ err }, "Failed to load Claude Agent SDK");
      return {
        content: `Error: Failed to load Claude Agent SDK: ${message}`,
        isError: true,
      };
    }

    const { query } = sdkModule;

    // Collect stderr output from the Claude Code subprocess for debugging
    const stderrLines: string[] = [];

    log.info(
      {
        prompt: truncate(prompt, 100, ""),
        workingDir,
        model,
        resume: !!resumeSessionId,
      },
      "Starting Claude Code session",
    );

    // Build the canUseTool callback, enforcing profile-based restrictions
    const canUseTool: import("@anthropic-ai/claude-agent-sdk").CanUseTool =
      async (toolName, toolInput, _options) => {
        // Profile hard-deny check first
        if (profilePolicy.deny.has(toolName)) {
          log.debug(
            { toolName, profile: profileName },
            "Tool denied by profile policy",
          );
          return {
            behavior: "deny" as const,
            message: `Tool "${toolName}" is denied by profile "${profileName}"`,
          };
        }

        // Profile explicit allow (auto-approve)
        if (profilePolicy.allow.has(toolName)) {
          return { behavior: "allow" as const };
        }

        // Auto-approve safe read-only tools (general profile default)
        if (AUTO_APPROVE_TOOLS.has(toolName)) {
          return { behavior: "allow" as const };
        }

        // For tools that need approval, bridge to Vellum's confirmation flow
        if (!context.requestConfirmation) {
          log.warn(
            { toolName },
            "Claude Code tool requires approval but no requestConfirmation callback available",
          );
          return {
            behavior: "deny" as const,
            message: "Tool approval not available in this context",
          };
        }

        try {
          const result = await context.requestConfirmation({
            toolName,
            input: toolInput,
            riskLevel: APPROVAL_REQUIRED_TOOLS.has(toolName) ? "Medium" : "Low",
            principal: context.principal,
          });
          if (result.decision === "allow") {
            return { behavior: "allow" as const };
          }
          return {
            behavior: "deny" as const,
            message: `User denied ${toolName}`,
          };
        } catch (err) {
          log.debug(
            { err, toolName },
            "requestConfirmation rejected (likely abort)",
          );
          return {
            behavior: "deny" as const,
            message: "Approval request cancelled",
          };
        }
      };

    // Enforce nesting depth limit to prevent infinite recursion.
    const currentDepth = parseInt(process.env[DEPTH_ENV_VAR] ?? "0", 10);
    if (currentDepth >= MAX_CLAUDE_CODE_DEPTH) {
      log.warn(
        { currentDepth, max: MAX_CLAUDE_CODE_DEPTH },
        "Claude Code nesting depth exceeded",
      );
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
    const queryOptions: import("@anthropic-ai/claude-agent-sdk").Options = {
      cwd: workingDir,
      model,
      canUseTool,
      permissionMode: "default",
      allowedTools: [...AUTO_APPROVE_TOOLS],
      env: subprocessEnv,
      maxTurns: 50,
      persistSession: true,
      stderr: (data: string) => {
        const trimmed = data.trimEnd();
        if (trimmed) {
          stderrLines.push(trimmed);
          log.debug({ stderr: trimmed }, "Claude Code subprocess stderr");
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
      const conversation = query({ prompt, options: queryOptions });
      let resultText = "";
      let conversationId = "";
      let hasError = false;

      // Track tool_use_id → {name, inputSummary} for enriching progress events.
      const toolUseIdInfo = new Map<
        string,
        { name: string; inputSummary: string }
      >();
      // Track tool_use_ids that we've already emitted tool_start for (to avoid duplicates).
      const emittedToolUseIds = new Set<string>();

      for await (const message of conversation) {
        switch (message.type) {
          case "assistant": {
            // Check for SDK-level errors on the assistant message
            if (message.error) {
              log.error(
                { error: message.error, conversationId: message.session_id },
                "Claude Code assistant message error",
              );
              hasError = true;
              resultText += `\n\n[Claude Code error: ${message.error}]`;
            }
            // Extract text from assistant messages
            if (message.message?.content) {
              for (const block of message.message.content) {
                if (block.type === "text") {
                  context.onOutput?.(block.text);
                  resultText += block.text;
                }
                if (block.type === "tool_use") {
                  // Capture info keyed by tool_use_id for enriching tool_progress events.
                  const inputSummary = summarizeToolInput(
                    block.name,
                    block.input as Record<string, unknown>,
                  );
                  toolUseIdInfo.set(block.id, {
                    name: block.name,
                    inputSummary,
                  });

                  // Emit tool_start if we haven't already (tool_progress may have fired first).
                  // NOTE: Do NOT emit tool_complete for the previous tool here. An assistant
                  // message may contain multiple tool_use blocks (parallel tool use) and none
                  // of them have executed yet at this point. Completions are handled by
                  // tool_use_summary and tool_progress events.
                  if (!emittedToolUseIds.has(block.id)) {
                    context.onOutput?.(
                      JSON.stringify({
                        subType: "tool_start",
                        subToolName: block.name,
                        subToolInput: inputSummary,
                        subToolId: block.id,
                      }),
                    );
                    emittedToolUseIds.add(block.id);
                    lastSubToolName = block.name;
                    activeToolUseId = block.id;
                  }
                }
              }
            }
            conversationId = message.session_id;
            break;
          }
          case "tool_progress": {
            // The SDK fires tool_progress periodically DURING tool execution.
            // This is our primary signal for live sub-tool progress.
            const toolUseId = message.tool_use_id;
            const toolName = message.tool_name;
            conversationId = message.session_id;

            // Record tool name if we don't have it yet (tool_progress fires before assistant sometimes).
            if (!toolUseIdInfo.has(toolUseId)) {
              toolUseIdInfo.set(toolUseId, {
                name: toolName,
                inputSummary: "",
              });
            }

            if (!emittedToolUseIds.has(toolUseId)) {
              // New tool - mark previous as complete and emit tool_start.
              if (lastSubToolName && activeToolUseId !== toolUseId) {
                context.onOutput?.(
                  JSON.stringify({
                    subType: "tool_complete",
                    subToolName: lastSubToolName,
                    subToolId: activeToolUseId,
                  }),
                );
              }
              const inputSummary =
                toolUseIdInfo.get(toolUseId)?.inputSummary ?? "";
              context.onOutput?.(
                JSON.stringify({
                  subType: "tool_start",
                  subToolName: toolName,
                  subToolInput: inputSummary,
                  subToolId: toolUseId,
                }),
              );
              emittedToolUseIds.add(toolUseId);
              lastSubToolName = toolName;
            }
            activeToolUseId = toolUseId;
            break;
          }
          case "tool_use_summary": {
            // The SDK fires tool_use_summary after tool execution with a summary
            // and the IDs of tools that were executed.
            conversationId = message.session_id;
            for (const completedId of message.preceding_tool_use_ids) {
              const info = toolUseIdInfo.get(completedId);
              const completedName: string | null =
                info?.name ?? lastSubToolName;
              if (completedName && emittedToolUseIds.has(completedId)) {
                context.onOutput?.(
                  JSON.stringify({
                    subType: "tool_complete",
                    subToolName: completedName,
                    subToolId: completedId,
                  }),
                );
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
          case "result": {
            // Mark the final sub-tool as complete (flag error if the session failed).
            if (lastSubToolName) {
              const isFailure = message.subtype !== "success";
              context.onOutput?.(
                JSON.stringify({
                  subType: "tool_complete",
                  subToolName: lastSubToolName,
                  subToolId: activeToolUseId,
                  ...(isFailure && { subToolIsError: true }),
                }),
              );
              lastSubToolName = null;
            }
            conversationId = message.session_id;
            const resultMeta = {
              subtype: message.subtype,
              numTurns: message.num_turns,
              durationMs: message.duration_ms,
              costUsd: message.total_cost_usd,
              stopReason: message.stop_reason,
            };

            if (message.subtype === "success") {
              log.info(
                resultMeta,
                "Claude Code session completed successfully",
              );
              if (message.result && !resultText) {
                resultText = message.result;
              }
            } else {
              // Error result - surface the subtype and details
              hasError = true;
              const errors = message.errors ?? [];
              const denials = message.permission_denials ?? [];

              log.error(
                { ...resultMeta, errors, permissionDenials: denials.length },
                "Claude Code session failed",
              );

              const parts: string[] = [];
              parts.push(
                `[${message.subtype}] (${message.num_turns} turns, ${(
                  message.duration_ms / 1000
                ).toFixed(1)}s)`,
              );
              if (errors.length > 0) {
                parts.push(`Errors: ${errors.join("; ")}`);
              }
              if (denials.length > 0) {
                const denialSummary = denials
                  .map((d: { tool_name: string }) => `${d.tool_name}`)
                  .join(", ");
                parts.push(`Permission denied: ${denialSummary}`);
              }
              resultText += `\n\n${parts.join("\n")}`;
            }
            break;
          }
          default:
            // Log unhandled message types at debug level for diagnostics
            log.debug(
              { messageType: message.type },
              "Claude Code unhandled message type",
            );
            break;
        }
      }

      const output =
        resultText.trim() ||
        "Claude Code completed without producing text output.";
      const sessionInfo = conversationId
        ? `\n\n[Claude Code session: ${conversationId}]`
        : "";

      return {
        content: output + sessionInfo,
        isError: hasError,
      };
    } catch (err) {
      // Mark the last sub-tool as failed so the UI shows an error icon.
      if (lastSubToolName) {
        context.onOutput?.(
          JSON.stringify({
            subType: "tool_complete",
            subToolName: lastSubToolName,
            subToolId: activeToolUseId,
            subToolIsError: true,
          }),
        );
        lastSubToolName = null;
      }

      const errMessage = err instanceof Error ? err.message : String(err);
      const recentStderr = stderrLines.slice(-20);
      log.error(
        { err, stderrTail: recentStderr },
        "Claude Code execution failed",
      );

      const parts = [`Claude Code error: ${errMessage}`];
      if (recentStderr.length > 0) {
        parts.push(
          `\nSubprocess stderr (last ${
            recentStderr.length
          } lines):\n${recentStderr.join("\n")}`,
        );
      }
      return {
        content: parts.join(""),
        isError: true,
      };
    }
  },
};
