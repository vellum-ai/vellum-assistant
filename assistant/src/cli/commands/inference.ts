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

import type { Command } from "commander";

import { cliIpcCall } from "../../ipc/cli-client.js";
import { readStdinSync } from "../../util/read-stdin.js";
import { applyCommandHelp, subcommand } from "../lib/cli-command-help.js";
import { registerCommand } from "../lib/register-command.js";
import { log } from "../logger.js";
import { inferenceHelp, llmHelp } from "./inference.help.js";
import { attachCallsitesSubcommand } from "./inference-callsites.js";
import { attachModelsSubcommand } from "./inference-models.js";
import { attachProfilesSubcommand } from "./inference-profiles.js";
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
 * Attach the `send` subcommand's action to the given command group
 * (`inference` or `llm`). Both groups share the same implementation.
 */
function attachSendSubcommand(group: Command): void {
  subcommand(group, "send").action(
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
          messageText = readStdinSync().trim();
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
      if (systemPrompt) {
        body.systemPrompt = systemPrompt;
      }
      if (model) {
        body.model = model;
      }
      if (profile) {
        body.profile = profile;
      }
      if (maxTokens) {
        body.maxTokens = maxTokens;
      }

      const ipcResult = await cliIpcCall<InferenceSendResult>(
        "inference_send",
        { body },
        { timeoutMs },
      );

      if (!ipcResult.ok) {
        writeCliError(ipcResult.error ?? "Unknown error occurred", jsonOutput);
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
    name: inferenceHelp.name,
    transport: "ipc",
    description: inferenceHelp.description,
    build: (inference) => {
      applyCommandHelp(inference, inferenceHelp);

      attachSendSubcommand(inference);
      attachSessionSubcommand(inference);
      attachProvidersSubcommand(inference);
      attachModelsSubcommand(inference);
      attachProfilesSubcommand(inference);
      attachCallsitesSubcommand(inference);
    },
  });

  const llm = program.command(llmHelp.name).description(llmHelp.description);
  applyCommandHelp(llm, llmHelp);
  attachSendSubcommand(llm);
}
