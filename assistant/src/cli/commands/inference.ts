import { readFileSync } from "node:fs";

import type { Command } from "commander";

import {
  cliIpcCall,
  cliIpcCallStream,
  exitFromIpcResult,
} from "../../ipc/cli-client.js";
import { log } from "../logger.js";
import { registerCommand } from "../lib/register-command.js";
import { attachSessionSubcommand } from "./inference-session.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface InferenceSendResult {
  ok: boolean;
  response: string;
  model: string;
  usage: { inputTokens: number; outputTokens: number };
}

// ---------------------------------------------------------------------------
// attachSendSubcommand
// ---------------------------------------------------------------------------

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
    .option("--stream", "Stream response tokens to stdout in real-time")
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
  - --stream pipes response chunks to stdout as they arrive.
  - Requires a configured LLM provider (see 'assistant config set').

Examples:
  $ assistant inference send "What is 2+2?"
  $ echo "Summarize this" | assistant inference send
  $ assistant llm send --system-prompt "You are a poet" "Write a haiku"
  $ assistant inference send --model claude-sonnet-4-20250514 --json "Hello"
  $ assistant inference send --profile balanced "Explain RFC 1149"
  $ assistant inference send --stream "Tell me a long story"`,
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
          stream?: boolean;
        },
        cmd: Command,
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

        // Build IPC params object.
        const params: Record<string, unknown> = { message: messageText };
        if (systemPrompt) params.systemPrompt = systemPrompt;
        if (model) params.model = model;
        if (profile) params.profile = profile;
        if (maxTokens !== undefined) params.maxTokens = maxTokens;
        if (opts.stream) params.stream = true;

        if (opts.stream) {
          const r = await cliIpcCallStream("inference_send", { body: params });
          if (!r.ok) return exitFromIpcResult(r, cmd);
          for await (const chunk of r.body) {
            process.stdout.write(chunk);
          }
        } else {
          const r = await cliIpcCall<InferenceSendResult>("inference_send", { body: params });
          if (!r.ok) return exitFromIpcResult(r, cmd);
          if (jsonOutput) {
            process.stdout.write(
              JSON.stringify({
                ok: true,
                response: r.result!.response,
                model: r.result!.model,
                usage: r.result!.usage,
              }) + "\n",
            );
          } else {
            process.stdout.write(r.result!.response + "\n");
          }
        }
      },
    );
}

// ---------------------------------------------------------------------------
// registerInferenceCommand
// ---------------------------------------------------------------------------

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
    },
  });

  registerCommand(program, {
    name: "llm",
    transport: "ipc",
    description: "LLM inference operations (alias for 'inference send')",
    build: (llm) => {
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
    },
  });
}
