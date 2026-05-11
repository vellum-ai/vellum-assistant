/**
 * `assistant inference` and `assistant llm` CLI namespace.
 *
 * Subcommands:
 *   - `send`       — Send a message to the configured LLM (via `inference_send` IPC)
 *   - `session`    — Manage conversation-scoped inference profile sessions
 *   - `providers`  — Inference provider admin commands
 *
 * The `llm` alias exposes only `send`.
 */

import { readFileSync } from "node:fs";

import type { Command } from "commander";

import { cliIpcCall } from "../../ipc/cli-client.js";
import { registerCommand } from "../lib/register-command.js";
import { log } from "../logger.js";
import { attachProvidersSubcommand } from "./inference-providers.js";
import { attachSessionSubcommand } from "./inference-session.js";

// ── Types ────────────────────────────────────────────────────────────

interface InferenceSendResult {
  response: string;
  model: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
}

// ── Send subcommand ──────────────────────────────────────────────────

/**
 * Attach the `send` subcommand to the given command group (`inference` or
 * `llm`). Both groups share the same implementation.
 */
function attachSendSubcommand(group: Command): void {
  group
    .command("send")
    .description("Send a message to the configured LLM and print the response")
    .option("--system-prompt <text>", "System prompt for the model")
    .option("--model <model-id>", "Model override")
    .option(
      "--profile <name>",
      "Apply a named inference profile from llm.profiles for this single call",
    )
    .option("--max-tokens <n>", "Max response tokens", undefined)
    .option("--json", "Output structured JSON")
    .argument("[message...]", "User message (joined with spaces)")
    .addHelpText(
      "after",
      `
Behavioral notes:
  - If no message argument is provided, reads from stdin.
  - If --model is omitted, uses the configured default model.
  - --profile applies a named profile from llm.profiles for this single call
    only. It does NOT open a session — to pin a profile to a conversation,
    use 'assistant inference profile open <name>'.
  - --profile layers below --model: --model still wins on the model field.
  - Requires a configured LLM provider (see 'assistant config set').

Examples:
  $ assistant inference send "What is 2+2?"
  $ echo "Summarize this" | assistant inference send
  $ assistant llm send --system-prompt "You are a poet" "Write a haiku"
  $ assistant inference send --model claude-sonnet-4-20250514 --json "Hello"
  $ assistant inference send --profile balanced "Explain RFC 1149"`,
    )
    .action(
      async (
        messageParts: string[],
        opts: {
          systemPrompt?: string;
          model?: string;
          profile?: string;
          maxTokens?: string;
          json?: boolean;
        },
      ) => {
        const { systemPrompt, model, profile, json: jsonOutput } = opts;
        const maxTokens = opts.maxTokens
          ? parseInt(opts.maxTokens, 10)
          : undefined;

        if (
          opts.maxTokens !== undefined &&
          (!Number.isFinite(maxTokens) || maxTokens! < 1)
        ) {
          const msg = "Invalid --max-tokens value. Must be a positive integer.";
          if (jsonOutput) {
            process.stdout.write(
              JSON.stringify({ ok: false, error: msg }) + "\n",
            );
          } else {
            log.error(msg);
          }
          process.exitCode = 1;
          return;
        }

        // Determine user message: positional args or stdin.
        let messageText = messageParts.length > 0 ? messageParts.join(" ") : "";

        if (!messageText && !process.stdin.isTTY) {
          try {
            messageText = readFileSync("/dev/stdin", "utf-8").trim();
          } catch {
            // stdin not available or empty
          }
        }

        if (!messageText) {
          const msg =
            "No message provided. Pass a message as an argument or pipe via stdin.";
          if (jsonOutput) {
            process.stdout.write(
              JSON.stringify({ ok: false, error: msg }) + "\n",
            );
          } else {
            log.error(msg);
          }
          process.exitCode = 1;
          return;
        }

        // Build IPC body
        const body: Record<string, unknown> = { message: messageText };
        if (systemPrompt) body.systemPrompt = systemPrompt;
        if (model) body.model = model;
        if (profile) body.profile = profile;
        if (maxTokens) body.maxTokens = maxTokens;

        const ipcResult = await cliIpcCall<InferenceSendResult>(
          "inference_send",
          { body },
        );

        if (!ipcResult.ok) {
          if (jsonOutput) {
            process.stdout.write(
              JSON.stringify({ ok: false, error: ipcResult.error }) + "\n",
            );
          } else {
            log.error(ipcResult.error ?? "Unknown error occurred");
          }
          process.exitCode = 1;
          return;
        }

        const result = ipcResult.result!;

        if (jsonOutput) {
          process.stdout.write(
            JSON.stringify({
              ok: true,
              response: result.response,
              model: result.model,
              usage: result.usage,
            }) + "\n",
          );
        } else {
          process.stdout.write(result.response + "\n");
        }
      },
    );
}

// ── Registration ─────────────────────────────────────────────────────

/**
 * Register `inference` and `llm` command groups on the top-level program.
 * Both expose `send`. Profile management is only available under `inference`.
 */
export function registerInferenceCommand(program: Command): void {
  registerCommand(program, {
    name: "inference",
    transport: "ipc",
    description: "LLM inference operations",
    build: (inference) => {
  inference.addHelpText(
    "after",
    `
The inference command group sends requests to your configured LLM provider.
The provider is resolved from your assistant config (llm.default.provider).

Examples:
  $ assistant inference send "What is the capital of France?"
  $ echo "Explain quantum computing" | assistant inference send
  $ assistant llm send --system-prompt "Be concise" "What is TCP?"
  $ assistant inference send --model claude-sonnet-4-20250514 --json "Hello"
  $ assistant inference send --profile balanced "Explain RFC 1149"`,
  );

  attachSendSubcommand(inference);
  attachSessionSubcommand(inference);
  attachProvidersSubcommand(inference);
    },
  });

  const llm = program
    .command("llm")
    .description("LLM inference operations (alias for 'inference send')");

  llm.addHelpText(
    "after",
    `
The llm command group is a shorthand for 'assistant inference send'. It sends
requests to your configured LLM provider, resolved from your assistant config
(llm.default.provider). For profile session management, use 'assistant inference session'.

Examples:
  $ assistant llm send "What is the capital of France?"
  $ echo "Explain quantum computing" | assistant llm send
  $ assistant llm send --system-prompt "Be concise" "What is TCP?"
  $ assistant llm send --model claude-sonnet-4-20250514 --json "Hello"
  $ assistant llm send --profile balanced "Explain RFC 1149"`,
  );

  attachSendSubcommand(llm);
}
