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

const DEFAULT_INFERENCE_IPC_TIMEOUT_MS = 32 * 60 * 1000;
const MAX_TIMER_TIMEOUT_MS = 2_147_483_647;
const MAX_INFERENCE_TIMEOUT_SECONDS = Math.floor(MAX_TIMER_TIMEOUT_MS / 1000);

function parsePositiveIntegerOption(
  raw: string | undefined,
  flagName: string,
  options: { max?: number } = {},
): { ok: true; value: number | undefined } | { ok: false; error: string } {
  if (raw === undefined) {
    return { ok: true, value: undefined };
  }

  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    return {
      ok: false,
      error: `Invalid ${flagName} value. Must be a positive integer.`,
    };
  }

  const value = Number(trimmed);
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    (options.max !== undefined && value > options.max)
  ) {
    return {
      ok: false,
      error:
        `Invalid ${flagName} value. Must be a positive integer` +
        (options.max !== undefined ? ` no greater than ${options.max}` : "") +
        ".",
    };
  }

  return { ok: true, value };
}

function writeCliError(message: string, jsonOutput?: boolean): void {
  if (jsonOutput) {
    process.stdout.write(JSON.stringify({ ok: false, error: message }) + "\n");
  } else {
    log.error(message);
  }
  process.exitCode = 1;
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
    .option(
      "--timeout-seconds <seconds>",
      "Maximum time to wait for the inference response",
      undefined,
    )
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
  - Long-running requests wait up to 32 minutes by default. Use
    --timeout-seconds to adjust the wait budget for this call.
  - Requires a configured LLM provider (see 'assistant config set').

Examples:
  $ assistant inference send "What is 2+2?"
  $ echo "Summarize this" | assistant inference send
  $ assistant llm send --system-prompt "You are a poet" "Write a haiku"
  $ assistant inference send --timeout-seconds 300 "Draft a long memo"
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
          timeoutSeconds?: string;
          json?: boolean;
        },
      ) => {
        const { systemPrompt, model, profile, json: jsonOutput } = opts;
        const parsedMaxTokens = parsePositiveIntegerOption(
          opts.maxTokens,
          "--max-tokens",
        );
        const parsedTimeoutSeconds = parsePositiveIntegerOption(
          opts.timeoutSeconds,
          "--timeout-seconds",
          { max: MAX_INFERENCE_TIMEOUT_SECONDS },
        );

        if (!parsedMaxTokens.ok) {
          writeCliError(parsedMaxTokens.error, jsonOutput);
          return;
        }

        if (!parsedTimeoutSeconds.ok) {
          writeCliError(parsedTimeoutSeconds.error, jsonOutput);
          return;
        }

        const maxTokens = parsedMaxTokens.value;
        const timeoutMs =
          parsedTimeoutSeconds.value !== undefined
            ? parsedTimeoutSeconds.value * 1000
            : DEFAULT_INFERENCE_IPC_TIMEOUT_MS;

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
          writeCliError(msg, jsonOutput);
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
          { timeoutMs },
        );

        if (!ipcResult.ok) {
          writeCliError(
            ipcResult.error ?? "Unknown error occurred",
            jsonOutput,
          );
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
