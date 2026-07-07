import { existsSync, readFileSync } from "node:fs";

import type { Command } from "commander";

import { cliIpcCall, exitFromIpcResult } from "../../ipc/cli-client.js";
import { readStdinSync } from "../../util/read-stdin.js";
import { registerCommand } from "../lib/register-command.js";
import { log } from "../logger.js";

// -- Import payload schema (local, no daemon imports) --

interface ImportMessage {
  role: string;
  content: string | Array<{ type: string; text: string }>;
  createdAt?: number;
}

interface ImportConversation {
  sourceKey?: string;
  title: string;
  createdAt?: number;
  updatedAt?: number;
  messages: ImportMessage[];
}

interface ImportPayload {
  conversations: ImportConversation[];
}

interface ImportResult {
  ok: boolean;
  imported: number;
  skipped: number;
  messages: number;
  errors: Array<{
    index: number;
    sourceKey?: string;
    error: string;
  }>;
}

// -- Validation (pure logic, no daemon imports) --

function validatePayload(raw: unknown): ImportPayload {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Input must be a JSON object with a 'conversations' array");
  }
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.conversations)) {
    throw new Error("Input must have a 'conversations' array");
  }
  for (let i = 0; i < obj.conversations.length; i++) {
    const conv = obj.conversations[i] as Record<string, unknown>;
    if (!conv.title || typeof conv.title !== "string") {
      throw new Error(
        `conversations[${i}].title is required and must be a string`,
      );
    }
    if (!Array.isArray(conv.messages) || conv.messages.length === 0) {
      throw new Error(`conversations[${i}].messages must be a non-empty array`);
    }
    for (let j = 0; j < (conv.messages as unknown[]).length; j++) {
      const msg = (conv.messages as Array<Record<string, unknown>>)[j];
      if (!msg.role || typeof msg.role !== "string") {
        throw new Error(`conversations[${i}].messages[${j}].role is required`);
      }
      if (msg.content === undefined || msg.content === null) {
        throw new Error(
          `conversations[${i}].messages[${j}].content is required`,
        );
      }
    }
  }
  return obj as unknown as ImportPayload;
}

// -- CLI registration --

export function registerConversationsImportCommand(
  conversations: Command,
): void {
  registerCommand(conversations, {
    name: "import",
    transport: "ipc",
    description: "Import conversations from a standard JSON format",
    build: (cmd) => {
      cmd
        .option("--file <path>", "Read JSON from file instead of stdin")
        .option("--json", "Output result as machine-readable JSON")
        .addHelpText(
          "after",
          `
Imports conversations into the assistant from a standard JSON format.
Reads from stdin by default, or from a file with --file.

The input JSON must have the shape:
  { "conversations": [{ "title": "...", "messages": [...] }] }

Each conversation may include:
  sourceKey         External key for dedup (e.g. "chatgpt:abc123")
  createdAt         Unix epoch milliseconds for the conversation
  updatedAt         Unix epoch milliseconds for the conversation
  messages[].role   "user" or "assistant"
  messages[].content  String or array of {type, text} content blocks
  messages[].createdAt  Unix epoch milliseconds for the message

Messages are indexed for memory search after import. Re-importing with
the same sourceKey will skip already-imported conversations.

Examples:
  $ bun run scripts/parse-export.ts --file export.zip | assistant conversations import --json
  $ assistant conversations import --file import.json --json
  $ cat data.json | assistant conversations import`,
        )
        .action(async (opts: { file?: string; json?: boolean }) => {
          let raw: string;
          try {
            if (opts.file) {
              if (!existsSync(opts.file)) {
                throw new Error(`File not found: ${opts.file}`);
              }
              raw = readFileSync(opts.file, "utf-8");
            } else {
              if (process.stdin.isTTY) {
                throw new Error(
                  "No input provided. Pipe JSON into stdin or use --file <path>.",
                );
              }
              raw = readStdinSync();
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (opts.json) {
              log.info(JSON.stringify({ ok: false, error: msg }));
            } else {
              log.error(`Error: ${msg}`);
            }
            process.exitCode = 1;
            return;
          }

          let payload: ImportPayload;
          try {
            const parsed = JSON.parse(raw);
            payload = validatePayload(parsed);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (opts.json) {
              log.info(JSON.stringify({ ok: false, error: msg }));
            } else {
              log.error(`Error: ${msg}`);
            }
            process.exitCode = 1;
            return;
          }

          if (payload.conversations.length === 0) {
            const result = { ok: true, imported: 0, skipped: 0, messages: 0 };
            if (opts.json) {
              log.info(JSON.stringify(result));
            } else {
              log.info("No conversations to import.");
            }
            return;
          }

          const r = await cliIpcCall<ImportResult>("conversations_import", {
            body: {
              conversations: payload.conversations as unknown as Record<
                string,
                unknown
              >[],
            },
          });
          if (!r.ok)
            return exitFromIpcResult(
              r as { ok: false; error?: string; statusCode?: number },
            );

          const result = r.result!;
          if (opts.json) {
            log.info(JSON.stringify(result));
          } else {
            const lines = [
              `Imported ${result.imported} conversation(s) with ${result.messages} message(s).`,
            ];
            if (result.skipped > 0) {
              lines.push(
                `Skipped ${result.skipped} already-imported conversation(s).`,
              );
            }
            if (result.errors.length > 0) {
              lines.push(`Failed: ${result.errors.length} conversation(s).`);
            }
            log.info(lines.join("\n"));
          }
        });
    },
  });
}
