/**
 * `assistant plugin-skill` runs a plugin-resident skill script through
 * the assistant so the child receives the owning plugin's scoped
 * credential authority.
 */

import type { Command } from "commander";

import { cliIpcCall, exitFromIpcResult } from "../../ipc/cli-client.js";
import { applyCommandHelp, subcommand } from "../lib/cli-command-help.js";
import { registerCommand } from "../lib/register-command.js";
import { log } from "../logger.js";
import { shouldOutputJson, writeError, writeOutput } from "../output.js";
import { tryResolveConversationId } from "../utils/conversation-id.js";
import { pluginSkillHelp } from "./plugin-skill.help.js";

interface PluginSkillRunResponse {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export function registerPluginSkillCommand(program: Command): void {
  registerCommand(program, {
    name: pluginSkillHelp.name,
    transport: "ipc",
    description: pluginSkillHelp.description,
    build: (cmd) => {
      applyCommandHelp(cmd, pluginSkillHelp);

      subcommand(cmd, "run").action(
        async (
          skillId: string,
          script: string,
          scriptArgs: string[],
          opts: { conversationId?: string; timeout?: string },
          command: Command,
        ) => {
          const conversationId = tryResolveConversationId({
            explicit: opts.conversationId,
          });
          if (!conversationId) {
            writeError(
              command,
              "A conversation id is required. Run this from an active skill or pass --conversation-id.",
            );
            process.exitCode = 1;
            return;
          }

          const timeoutMs = parseInt(opts.timeout ?? "30000", 10);
          if (!Number.isFinite(timeoutMs) || timeoutMs < 1) {
            writeError(
              command,
              "Invalid timeout value. Must be a positive integer.",
            );
            process.exitCode = 1;
            return;
          }

          const r = await cliIpcCall<PluginSkillRunResponse>(
            "plugin_skill_run",
            {
              body: {
                conversationId,
                skillId,
                script,
                args: scriptArgs ?? [],
                revealNonce: process.env.__REVEAL_NONCE,
                timeoutMs,
              },
            },
            { timeoutMs: timeoutMs + 10_000 },
          );

          if (!r.ok) {
            return exitFromIpcResult(
              r as { ok: false; error?: string; statusCode?: number },
              command,
            );
          }

          const result = r.result!;
          if (shouldOutputJson(command)) {
            writeOutput(command, { ok: true, ...result });
          } else {
            if (result.stdout) {
              process.stdout.write(result.stdout);
              if (!result.stdout.endsWith("\n")) {
                process.stdout.write("\n");
              }
            }
            if (result.stderr) {
              process.stderr.write(result.stderr);
              if (!result.stderr.endsWith("\n")) {
                process.stderr.write("\n");
              }
            }
          }

          if (result.exitCode !== 0) {
            if (!shouldOutputJson(command)) {
              log.info(`Exit code: ${result.exitCode}`);
            }
            process.exitCode = result.exitCode;
          }
        },
      );
    },
  });
}
