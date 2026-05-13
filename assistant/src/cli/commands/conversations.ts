import type { Command } from "commander";

import { cliIpcCall, exitFromIpcResult } from "../../ipc/cli-client.js";
import { registerCommand } from "../lib/register-command.js";
import { timeAgo } from "../lib/time-ago.js";
import { log } from "../logger.js";
import { registerConversationsDeferCommand } from "./conversations-defer.js";
import { registerConversationsImportCommand } from "./conversations-import.js";

export function registerConversationsCommand(program: Command): void {
  registerCommand(program, {
    name: "conversations",
    transport: "ipc",
    description: "Manage conversations",
    build: (conversations) => {
      registerConversationsImportCommand(conversations);
      registerConversationsDeferCommand(conversations);

      conversations.addHelpText(
        "after",
        `
Conversations with the assistant. Each conversation has a unique ID and a
title. All subcommands communicate via IPC and require the assistant to be
running.

Examples:
  $ assistant conversations list
  $ assistant conversations new "Project planning"
  $ assistant conversations export
  $ assistant conversations clear`,
      );

      // -------------------------------------------------------------------
      // list
      // -------------------------------------------------------------------

      conversations
        .command("list")
        .description("List conversations (excludes archived by default)")
        .option(
          "--include-archived",
          "Include archived conversations in the output",
        )
        .addHelpText(
          "after",
          `
Shows conversations with their ID, title, and a relative timestamp (e.g.
"3 hours ago"). Conversations are listed in order of most recently updated.
Archived conversations are excluded by default; pass --include-archived to
include them.

Examples:
  $ assistant conversations list
  $ assistant conversations list --include-archived`,
        )
        .action(async (opts?: { includeArchived?: boolean }) => {
          const result = await cliIpcCall<{
            conversations: Array<{
              id: string;
              title: string | null;
              updatedAt: number;
            }>;
          }>("conversation_list_cli", {
            body: { includeArchived: opts?.includeArchived ?? false },
          });

          if (!result.ok) return exitFromIpcResult(result);

          const all = result.result!.conversations;
          if (all.length === 0) {
            log.info("No conversations");
          } else {
            for (const s of all) {
              log.info(
                `  ${s.id}  ${s.title ?? "Untitled"}  ${timeAgo(s.updatedAt)}`,
              );
            }
          }
        });

      // -------------------------------------------------------------------
      // new
      // -------------------------------------------------------------------

      conversations
        .command("new [title]")
        .description("Create a new conversation")
        .addHelpText(
          "after",
          `
Arguments:
  title   Optional conversation title (string). If omitted, a default title is
          assigned by the assistant.

Creates a new conversation and prints its title and ID.

Examples:
  $ assistant conversations new
  $ assistant conversations new "Project planning"
  $ assistant conversations new "Bug triage 2026-03-05"`,
        )
        .action(async (title?: string) => {
          const result = await cliIpcCall<{ id: string; title: string }>(
            "conversation_create_cli",
            { body: { title } },
          );

          if (!result.ok) return exitFromIpcResult(result);

          const conversation = result.result!;
          log.info(
            `Created conversation: ${conversation.title} (${conversation.id})`,
          );
        });

      // -------------------------------------------------------------------
      // rename
      // -------------------------------------------------------------------

      conversations
        .command("rename <conversationId> <title>")
        .description("Rename a conversation")
        .addHelpText(
          "after",
          `
Arguments:
  conversationId   Conversation ID (or unique prefix). Supports prefix matching.
                   Run 'assistant conversations list' to find IDs.
  title            The new title for the conversation. Should be concise (under
                   60 characters) and descriptive of the current topic.

Renames the conversation to the given title and marks it as a manual rename
(auto-generated titles will not overwrite it).

Examples:
  $ assistant conversations rename abc123 "Project planning"
  $ assistant conversations rename abc123 "Bug triage 2026-04-22"`,
        )
        .action(async (conversationId: string, title: string) => {
          const trimmedTitle = title.trim();
          if (!trimmedTitle) {
            log.error("Error: title must be a non-empty string");
            process.exit(1);
          }

          const ipcResult = await cliIpcCall<{ ok: boolean; error?: string }>(
            "rename_conversation",
            {
              body: { conversationId, title: trimmedTitle },
            },
          );

          if (!ipcResult.ok) {
            log.error(
              `Rename failed: ${ipcResult.error}. Run 'assistant conversations list' to verify the conversation exists.`,
            );
            process.exit(1);
          }

          const result = ipcResult.result!;
          if (!result.ok) {
            log.error(
              `Rename failed: ${result.error}. Run 'assistant conversations list' to see available conversations.`,
            );
            process.exit(1);
          }

          log.info(
            `Renamed conversation to "${trimmedTitle}" (${conversationId})`,
          );
        });

      // -------------------------------------------------------------------
      // export
      // -------------------------------------------------------------------

      conversations
        .command("export [conversationId]")
        .description("Export a conversation as markdown or JSON")
        .option("-f, --format <format>", "Output format: md or json", "md")
        .option("-o, --output <file>", "Write to file instead of stdout")
        .addHelpText(
          "after",
          `
Arguments:
  conversationId   Optional conversation ID (or unique prefix). Defaults to the
                   most recent conversation. Supports prefix matching — e.g.
                   "abc123" matches the first conversation whose ID starts with
                   "abc123". Run 'assistant conversations list' to find IDs.

Two output formats are available:
  md    Markdown conversation transcript (default). Human-readable rendering
        of messages with role headers.
  json  Structured JSON export with full metadata, message content arrays,
        and timestamps.

Examples:
  $ assistant conversations export
  $ assistant conversations export --format json -o conversation.json
  $ assistant conversations export abc123 --format md`,
        )
        .action(
          async (
            conversationId?: string,
            opts?: { format: string; output?: string },
          ) => {
            const format = opts?.format ?? "md";
            if (format !== "md" && format !== "json") {
              log.error('Error: format must be "md" or "json"');
              process.exit(1);
            }

            const result = await cliIpcCall<{
              output: string;
              conversationId: string;
            }>("conversation_export_cli", {
              body: { conversationId, format },
            });

            if (!result.ok) return exitFromIpcResult(result);

            const exported = result.result!;

            if (opts?.output) {
              const { writeFileSync } = await import("node:fs");
              writeFileSync(opts.output, exported.output);
              log.info(`Exported to ${opts.output}`);
            } else {
              process.stdout.write(exported.output);
            }
          },
        );

      // -------------------------------------------------------------------
      // clear
      // -------------------------------------------------------------------

      conversations
        .command("clear")
        .description(
          "Clear all conversations, messages, and vector data (dev only)",
        )
        .addHelpText(
          "after",
          `
Permanently deletes ALL conversations, messages, and associated data.
Prompts for confirmation (y/N) before proceeding.

Requires the assistant to be running. Communicates via IPC socket.

Intended for development use. This action cannot be undone.

Examples:
  $ assistant conversations clear`,
        )
        .action(async () => {
          log.info(
            "This will permanently delete all conversations, messages, and vector data.",
          );

          const readline = await import("node:readline");
          const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
          });
          const answer = await new Promise<string>((resolve) => {
            rl.question("Are you sure? (y/N) ", resolve);
          });
          rl.close();
          if (answer.toLowerCase() !== "y") {
            log.info("Cancelled");
            return;
          }

          const result = await cliIpcCall<{ cleared: number }>(
            "conversations_clear_cli",
          );

          if (!result.ok) return exitFromIpcResult(result);

          log.info(
            `Cleared ${result.result!.cleared} conversations. Done.`,
          );
        });

      // -------------------------------------------------------------------
      // wipe
      // -------------------------------------------------------------------

      conversations
        .command("wipe <conversationId>")
        .description(
          "Wipe a conversation and revert all memory changes it made",
        )
        .option("-y, --yes", "Skip confirmation prompt")
        .addHelpText(
          "after",
          `
Arguments:
  conversationId   Conversation ID (or unique prefix). Supports prefix matching.
                   Run 'assistant conversations list' to find IDs.

Permanently wipes the conversation and reverts all memory changes it caused:
restores superseded memory items, deletes conversation summaries, and cancels
pending memory jobs. This action cannot be undone.

Examples:
  $ assistant conversations wipe abc123
  $ assistant conversations wipe abc123 --yes`,
        )
        .action(async (conversationId: string, opts?: { yes?: boolean }) => {
          if (!opts?.yes) {
            const readline = await import("node:readline");
            const rl = readline.createInterface({
              input: process.stdin,
              output: process.stdout,
            });
            const answer = await new Promise<string>((resolve) => {
              rl.question(
                `Wipe conversation "${conversationId}" and revert all memory changes? (y/N) `,
                resolve,
              );
            });
            rl.close();
            if (answer.toLowerCase() !== "y") {
              log.info("Cancelled");
              return;
            }
          }

          const ipcResult = await cliIpcCall<{
            wiped: boolean;
            unsupersededItems: number;
            deletedSummaries: number;
            cancelledJobs: number;
          }>("wipe_conversation", {
            body: { conversationId },
          });

          if (!ipcResult.ok) return exitFromIpcResult(ipcResult);

          const result = ipcResult.result!;
          log.info(
            `Wiped conversation. ` +
              `Restored ${result.unsupersededItems} memory items, ` +
              `deleted ${result.deletedSummaries} summaries, ` +
              `cancelled ${result.cancelledJobs} jobs.`,
          );
        });

      // -------------------------------------------------------------------
      // wake
      // -------------------------------------------------------------------

      conversations
        .command("wake <conversationId>")
        .description(
          "Wake the agent on an existing conversation with an internal hint",
        )
        .requiredOption(
          "--hint <text>",
          "Hint message visible to the LLM (not persisted to transcript)",
        )
        .option(
          "--source <label>",
          "Source label for logging (e.g. github-notification)",
          "cli",
        )
        .option("--json", "Output result as JSON")
        .addHelpText(
          "after",
          `
Arguments:
  conversationId   Conversation ID to wake.

Wake the assistant's agent loop on an existing conversation without a user
message. The hint is injected as a non-persisted internal message visible
only to the LLM — it never appears in the transcript or SSE feed. If the
agent produces output (text or tool calls), it is persisted and emitted to
connected clients. Otherwise the wake is a silent no-op.

Requires the assistant to be running. Communicates via IPC socket.

Examples:
  $ assistant conversations wake abc123 --hint "PR #25933 received a review requesting changes"
  $ assistant conversations wake abc123 --hint "CI failed on commit abc" --source github-ci
  $ assistant conversations wake abc123 --hint "New Slack DM from Vargas" --source slack --json`,
        )
        .action(
          async (
            conversationId: string,
            opts: { hint: string; source: string; json?: boolean },
          ) => {
            const result = await cliIpcCall<{
              invoked: boolean;
              producedToolCalls: boolean;
              reason?: "not_found" | "archived" | "timeout" | "no_resolver";
            }>("wake_conversation", {
              body: {
                conversationId,
                hint: opts.hint,
                source: opts.source,
              },
            });

            if (!result.ok) {
              if (opts.json) {
                log.info(JSON.stringify({ ok: false, error: result.error }));
              } else {
                log.error(`Error: ${result.error}`);
              }
              process.exitCode = 1;
              return;
            }

            const wake = result.result!;
            if (opts.json) {
              log.info(JSON.stringify({ ok: true, ...wake }));
              return;
            }
            if (wake.invoked) {
              log.info(
                wake.producedToolCalls
                  ? `Wake produced output on conversation ${conversationId}`
                  : `Wake invoked on ${conversationId} (no output produced)`,
              );
            } else if (wake.reason === "timeout") {
              log.info(
                `Conversation ${conversationId} is busy — wake skipped (retry later)`,
              );
            } else if (wake.reason === "archived") {
              log.error(
                `Could not wake conversation ${conversationId} — conversation is archived`,
              );
              process.exitCode = 1;
            } else {
              log.error(
                `Could not wake conversation ${conversationId} — conversation not found`,
              );
              process.exitCode = 1;
            }
          },
        );
    },
  });
}
