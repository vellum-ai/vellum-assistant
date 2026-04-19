import { readFileSync } from "node:fs";

import type { Command } from "commander";

import {
  extractAllText,
  getConfiguredProvider,
  userMessage,
} from "../../providers/provider-send-message.js";
import { log } from "../logger.js";

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
    .option("--max-tokens <n>", "Max response tokens", undefined)
    .option("--json", "Output structured JSON")
    .argument("[message...]", "User message (joined with spaces)")
    .addHelpText(
      "after",
      `
Behavioral notes:
  - If no message argument is provided, reads from stdin.
  - If --model is omitted, uses the configured default model.
  - Requires a configured LLM provider (see 'assistant config set').

Examples:
  $ assistant inference send "What is 2+2?"
  $ echo "Summarize this" | assistant inference send
  $ assistant llm send --system-prompt "You are a poet" "Write a haiku"
  $ assistant inference send --model claude-sonnet-4-20250514 --json "Hello"`,
    )
    .action(
      async (
        messageParts: string[],
        opts: {
          systemPrompt?: string;
          model?: string;
          maxTokens?: string;
          json?: boolean;
        },
      ) => {
        const { systemPrompt, model, json: jsonOutput } = opts;
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

        if (!messageText) {
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

        // Resolve provider.
        const provider = await getConfiguredProvider("inference");
        if (!provider) {
          const msg =
            "No LLM provider is configured. Run 'assistant config set llm.default.provider <provider>' to set one up.";
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

        try {
          const response = await provider.sendMessage(
            [userMessage(messageText)],
            undefined,
            systemPrompt,
            {
              config: {
                callSite: "inference",
                max_tokens: maxTokens,
                model,
              },
            },
          );

          const text = extractAllText(response);

          if (jsonOutput) {
            process.stdout.write(
              JSON.stringify({
                ok: true,
                response: text,
                model: response.model,
                usage: {
                  inputTokens: response.usage.inputTokens,
                  outputTokens: response.usage.outputTokens,
                },
              }) + "\n",
            );
          } else {
            process.stdout.write(text + "\n");
          }
        } catch (err) {
          const msg =
            err instanceof Error ? err.message : "Unknown error occurred";
          if (jsonOutput) {
            process.stdout.write(
              JSON.stringify({ ok: false, error: msg }) + "\n",
            );
          } else {
            log.error(msg);
          }
          process.exitCode = 1;
        }
      },
    );
}

/**
 * Register `inference` and `llm` command groups on the top-level program.
 * Both expose the same subcommands — `llm` is an alias for `inference`.
 */
export function registerInferenceCommand(program: Command): void {
  const inference = program
    .command("inference")
    .description("LLM inference operations");

  inference.addHelpText(
    "after",
    `
The inference command group sends requests to your configured LLM provider.
The provider is resolved from your assistant config (llm.default.provider).

Examples:
  $ assistant inference send "What is the capital of France?"
  $ echo "Explain quantum computing" | assistant inference send
  $ assistant llm send --system-prompt "Be concise" "What is TCP?"
  $ assistant inference send --model claude-sonnet-4-20250514 --json "Hello"`,
  );

  attachSendSubcommand(inference);

  const llm = program
    .command("llm")
    .description("LLM inference operations (alias for 'inference')");

  llm.addHelpText(
    "after",
    `
The llm command group is an alias for 'inference'. It sends requests to your
configured LLM provider, resolved from your assistant config (llm.default.provider).

Examples:
  $ assistant llm send "What is the capital of France?"
  $ echo "Explain quantum computing" | assistant llm send
  $ assistant llm send --system-prompt "Be concise" "What is TCP?"
  $ assistant llm send --model claude-sonnet-4-20250514 --json "Hello"`,
  );

  attachSendSubcommand(llm);
}
