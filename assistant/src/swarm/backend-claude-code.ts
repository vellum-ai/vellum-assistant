/**
 * Claude Code worker backend for swarm execution.
 *
 * Extracted from the swarm delegate tool so backend construction
 * is testable and swappable independently of the tool adapter.
 */

import { resolveModelIntent } from "../providers/model-intents.js";
import type { ModelIntent } from "../providers/types.js";
import { getSecureKeyAsync } from "../security/secure-keys.js";
import { getLogger } from "../util/logger.js";
import type {
  SwarmWorkerBackend,
  SwarmWorkerBackendInput,
} from "./worker-backend.js";
import { getProfilePolicy } from "./worker-backend.js";

const log = getLogger("swarm-backend-claude-code");

const MAX_CLAUDE_CODE_DEPTH = 1;
const DEPTH_ENV_VAR = "VELLUM_CLAUDE_CODE_DEPTH";

/**
 * Create a Claude Code worker backend that enforces profile-based tool policies.
 * Uses the Claude Agent SDK to run autonomous worker tasks.
 */
export function createClaudeCodeBackend(): SwarmWorkerBackend {
  return {
    name: "claude_code",

    async isAvailable(): Promise<boolean> {
      const apiKey =
        (await getSecureKeyAsync("anthropic")) ?? process.env.ANTHROPIC_API_KEY;
      return !!apiKey;
    },

    async runTask(input: SwarmWorkerBackendInput) {
      const start = Date.now();
      const stderrLines: string[] = [];
      try {
        const { query } = await import("@anthropic-ai/claude-agent-sdk");
        const apiKey =
          (await getSecureKeyAsync("anthropic")) ??
          process.env.ANTHROPIC_API_KEY;
        if (!apiKey) {
          return {
            success: false,
            output: "No API key",
            failureReason: "backend_unavailable" as const,
            durationMs: 0,
          };
        }

        const profilePolicy = getProfilePolicy(input.profile);

        // Enforce profile restrictions — swarm workers run autonomously so
        // there is no user to prompt; denied tools are blocked, everything
        // else is allowed.
        const canUseTool: import("@anthropic-ai/claude-agent-sdk").CanUseTool =
          async (toolName) => {
            if (profilePolicy.deny.has(toolName)) {
              log.debug(
                { toolName, profile: input.profile },
                "Swarm worker tool denied by profile",
              );
              return {
                behavior: "deny" as const,
                message: `Tool "${toolName}" is denied by profile "${input.profile}"`,
              };
            }
            return { behavior: "allow" as const };
          };

        // Enforce nesting depth limit
        const currentDepth = parseInt(process.env[DEPTH_ENV_VAR] ?? "0", 10);
        if (currentDepth >= MAX_CLAUDE_CODE_DEPTH) {
          log.warn(
            { currentDepth, max: MAX_CLAUDE_CODE_DEPTH },
            "Swarm worker nesting depth exceeded",
          );
          return {
            success: false,
            output: `Nesting depth exceeded (depth ${currentDepth}, max ${MAX_CLAUDE_CODE_DEPTH})`,
            failureReason: "backend_unavailable" as const,
            durationMs: Date.now() - start,
          };
        }

        // Strip the SDK's nesting guard but set our own depth counter.
        const subprocessEnv: Record<string, string | undefined> = {
          ...process.env,
          ANTHROPIC_API_KEY: apiKey,
          [DEPTH_ENV_VAR]: String(currentDepth + 1),
        };
        delete subprocessEnv.CLAUDECODE;
        delete subprocessEnv.CLAUDE_CODE_ENTRYPOINT;

        const conversation = query({
          prompt: input.prompt,
          options: {
            cwd: input.workingDir,
            model: input.modelIntent
              ? resolveModelIntent(
                  "anthropic",
                  input.modelIntent as ModelIntent,
                )
              : "claude-sonnet-4-6",
            canUseTool,
            permissionMode: "default",
            maxTurns: 30,
            env: subprocessEnv,
            stderr: (data: string) => {
              const trimmed = data.trimEnd();
              if (trimmed) {
                stderrLines.push(trimmed);
                log.debug(
                  { stderr: trimmed },
                  "Swarm worker subprocess stderr",
                );
              }
            },
          },
        });

        let resultText = "";
        let hasError = false;
        for await (const message of conversation) {
          if (input.signal?.aborted) break;
          if (message.type === "assistant") {
            if (message.error) {
              log.error(
                { error: message.error, conversationId: message.session_id },
                "Swarm worker assistant message error",
              );
              hasError = true;
              resultText += `\n[Claude Code error: ${message.error}]`;
            }
            if (message.message?.content) {
              for (const block of message.message.content) {
                if (block.type === "text") resultText += block.text;
              }
            }
          } else if (message.type === "result") {
            if (message.subtype === "success") {
              log.info(
                {
                  numTurns: message.num_turns,
                  durationMs: message.duration_ms,
                  costUsd: message.total_cost_usd,
                },
                "Swarm worker completed",
              );
              if (message.result && !resultText) {
                resultText = message.result;
              }
            } else {
              hasError = true;
              const errors = message.errors ?? [];
              const denials = message.permission_denials ?? [];
              log.error(
                {
                  subtype: message.subtype,
                  errors,
                  permissionDenials: denials.length,
                  numTurns: message.num_turns,
                  durationMs: message.duration_ms,
                },
                "Swarm worker session failed",
              );

              const parts: string[] = [
                `[${message.subtype}] (${message.num_turns} turns, ${(
                  message.duration_ms / 1000
                ).toFixed(1)}s)`,
              ];
              if (errors.length > 0) parts.push(`Errors: ${errors.join("; ")}`);
              if (denials.length > 0)
                parts.push(
                  `Permission denied: ${denials
                    .map((d: { tool_name: string }) => d.tool_name)
                    .join(", ")}`,
                );
              resultText += `\n${parts.join("\n")}`;
            }
          }
        }

        // Treat abort as non-retryable cancellation, not a retryable timeout
        if (input.signal?.aborted) {
          return {
            success: false,
            output: "Cancelled (aborted)",
            failureReason: "cancelled" as const,
            durationMs: Date.now() - start,
          };
        }

        return {
          success: !hasError,
          output: resultText || "Completed",
          durationMs: Date.now() - start,
        };
      } catch (err) {
        const errMessage = err instanceof Error ? err.message : String(err);
        const recentStderr = stderrLines.slice(-20);
        log.error(
          { err, stderrTail: recentStderr },
          "Swarm worker execution failed",
        );

        const parts = [errMessage];
        if (recentStderr.length > 0) {
          parts.push(
            `\nSubprocess stderr (last ${
              recentStderr.length
            } lines):\n${recentStderr.join("\n")}`,
          );
        }
        return {
          success: false,
          output: parts.join(""),
          failureReason: "backend_unavailable" as const,
          durationMs: Date.now() - start,
        };
      }
    },
  };
}
