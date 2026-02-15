/**
 * Claude Code worker backend for swarm execution.
 *
 * Extracted from the swarm delegate tool so backend construction
 * is testable and swappable independently of the tool adapter.
 */

import { getConfig } from '../config/loader.js';
import { getLogger } from '../util/logger.js';
import type { SwarmWorkerBackend, SwarmWorkerBackendInput } from './worker-backend.js';
import { getProfilePolicy } from './worker-backend.js';

const log = getLogger('swarm-backend-claude-code');

/**
 * Create a Claude Code worker backend that enforces profile-based tool policies.
 * Uses the Claude Agent SDK to run autonomous worker tasks.
 */
export function createClaudeCodeBackend(): SwarmWorkerBackend {
  return {
    name: 'claude_code',

    isAvailable(): boolean {
      const config = getConfig();
      const apiKey = config.apiKeys.anthropic ?? process.env.ANTHROPIC_API_KEY;
      return !!apiKey;
    },

    async runTask(input: SwarmWorkerBackendInput) {
      const start = Date.now();
      try {
        const { query } = await import('@anthropic-ai/claude-agent-sdk');
        const config = getConfig();
        const apiKey = config.apiKeys.anthropic ?? process.env.ANTHROPIC_API_KEY;
        if (!apiKey) {
          return { success: false, output: 'No API key', failureReason: 'backend_unavailable' as const, durationMs: 0 };
        }

        const profilePolicy = getProfilePolicy(input.profile);

        // Enforce profile restrictions — swarm workers run autonomously so
        // there is no user to prompt; denied tools are blocked, everything
        // else is allowed.
        const canUseTool: import('@anthropic-ai/claude-agent-sdk').CanUseTool = async (toolName) => {
          if (profilePolicy.deny.has(toolName)) {
            log.debug({ toolName, profile: input.profile }, 'Swarm worker tool denied by profile');
            return { behavior: 'deny' as const, message: `Tool "${toolName}" is denied by profile "${input.profile}"` };
          }
          return { behavior: 'allow' as const };
        };

        const conversation = query({
          prompt: input.prompt,
          options: {
            cwd: input.workingDir,
            model: input.model ?? 'claude-sonnet-4-5-20250929',
            canUseTool,
            permissionMode: 'default',
            maxTurns: 30,
            env: { ...process.env, ANTHROPIC_API_KEY: apiKey },
          },
        });

        let resultText = '';
        for await (const message of conversation) {
          if (input.signal?.aborted) break;
          if (message.type === 'assistant' && message.message?.content) {
            for (const block of message.message.content) {
              if (block.type === 'text') resultText += block.text;
            }
          } else if (message.type === 'result') {
            if (message.subtype === 'success' && message.result && !resultText) {
              resultText = message.result;
            }
          }
        }

        // Treat abort as cancellation, not success
        if (input.signal?.aborted) {
          return { success: false, output: 'Cancelled (aborted)', failureReason: 'timeout' as const, durationMs: Date.now() - start };
        }

        return { success: true, output: resultText || 'Completed', durationMs: Date.now() - start };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { success: false, output: message, failureReason: 'backend_unavailable' as const, durationMs: Date.now() - start };
      }
    },
  };
}
