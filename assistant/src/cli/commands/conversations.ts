import type { Command } from "commander";

import { cliIpcCall } from "../../ipc/cli-client.js";
import { log } from "../logger.js";
import { formatJson, formatMarkdown } from "../lib/conversation-formatter.js";
import { registerCommand } from "../lib/register-command.js";
import { timeAgo } from "../lib/time.js";
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
title. The assistant must be running for "new" (it communicates via the HTTP
API), while "list", "export", and "clear" operate on the local SQLite database
directly.

Examples:
  $ assistant conversations list
  $ assistant conversations new "Project planning"
  $ assistant conversations export
  $ assistant conversations clear`,
      );

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
          try {
            const r = await cliIpcCall<{
              conversations?: Array<{
                id: string;
                title?: string | null;
                updatedAt: number;
              }>;
            }>("listConversations", {
              queryParams: opts?.includeArchived
                ? { includeArchived: "true" }
                : undefined,
            });
            if (!r.ok) {
              log.error(`Failed to list conversations: ${r.error}`);
              process.exitCode = 1;
              return;
            }
            const all = r.result?.conversations ?? [];
            if (all.length === 0) {
              log.info("No conversations");
              return;
            }
            for (const s of all) {
              log.info(
                `  ${s.id}  ${s.title ?? "Untitled"}  ${timeAgo(s.updatedAt)}`,
              );
            }
          } catch (err) {
            log.error(
              `Error: ${err instanceof Error ? err.message : String(err)}`,
            );
            process.exitCode = 1;
          }
        });

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
          try {
            const r = await cliIpcCall<{ id: string; title?: string | null }>(
              "createConversation",
              { body: { title } },
            );
            if (!r.ok) {
              log.error(`Failed to create conversation: ${r.error}`);
              process.exitCode = 1;
              return;
            }
            log.info(
              `Created conversation: ${r.result!.title ?? "New Conversation"} (${r.result!.id})`,
            );
          } catch (err) {
            log.error(
              `Error: ${err instanceof Error ? err.message : String(err)}`,
            );
            process.exitCode = 1;
          }
        });

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
            try {
              const format = opts?.format ?? "md";
              if (format !== "md" && format !== "json") {
                log.error('Error: format must be "md" or "json"');
                process.exit(1);
              }

              let id = conversationId;
              if (!id) {
                // Get most recent conversation
                const listR = await cliIpcCall<{
                  conversations?: Array<{ id: string }>;
                }>("listConversations", {
                  queryParams: { limit: "1" },
                });
                if (
                  !listR.ok ||
                  !(listR.result?.conversations?.length)
                ) {
                  log.error("No conversations found");
                  process.exit(1);
                }
                id = listR.result!.conversations![0].id;
              }

              const r = await cliIpcCall<{
                ok: true;
                conversation: {
                  id: string;
                  title: string | null;
                  createdAt: number;
                  updatedAt: number;
                };
                messages: Array<{
                  role: string;
                  content: unknown[];
                  createdAt: number;
                }>;
              }>("conversation_export", { pathParams: { id } });

              if (!r.ok) {
                log.error(`Failed to export conversation: ${r.error}`);
                process.exitCode = 1;
                return;
              }

              const exportData = {
                id: r.result!.conversation.id,
                title: r.result!.conversation.title,
                createdAt: r.result!.conversation.createdAt,
                updatedAt: r.result!.conversation.updatedAt,
                messages: r.result!.messages,
              };

              const output =
                format === "json"
                  ? formatJson(
                      exportData as Parameters<typeof formatJson>[0],
                    )
                  : formatMarkdown(
                      exportData as Parameters<typeof formatMarkdown>[0],
                    );

              if (opts?.output) {
                const { writeFileSync } = await import("node:fs");
                writeFileSync(opts.output, output);
                log.info(`Exported to ${opts.output}`);
              } else {
                process.stdout.write(output);
              }
            } catch (err) {
              log.error(
                `Error: ${err instanceof Error ? err.message : String(err)}`,
              );
              process.exitCode = 1;
            }
          },
        );

      conversations
        .command("clear")
        .description(
          "Clear all conversations, messages, and vector data (dev only)",
        )
        .addHelpText(
          "after",
          `
Permanently deletes ALL conversations, messages, and Qdrant vector data.
Prompts for confirmation (y/N) before proceeding.

Intended for development use. This action cannot be undone.

Examples:
  $ assistant conversations clear`,
        )
        .action(async () => {
          try {
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

            const r = await cliIpcCall("clearAllConversations", {
              body: { confirm: "clear-all-conversations" },
            });
            if (!r.ok) {
              log.error(`Failed to clear conversations: ${r.error}`);
              process.exitCode = 1;
              return;
            }
            log.info("Cleared all conversations.");
          } catch (err) {
            log.error(
              `Error: ${err instanceof Error ? err.message : String(err)}`,
            );
            process.exitCode = 1;
          }
        });

      conversations
        .command("wipe <conversationId>")
        .description("Wipe a conversation and revert all memory changes it made")
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
          try {
            if (!opts?.yes) {
              // Fetch title for confirmation prompt
              const getR = await cliIpcCall<{
                ok: true;
                conversation?: { title?: string | null };
              }>("getConversation", { pathParams: { id: conversationId } });
              const title =
                getR.ok && getR.result?.conversation?.title
                  ? getR.result.conversation.title
                  : conversationId;

              const readline = await import("node:readline");
              const rl = readline.createInterface({
                input: process.stdin,
                output: process.stdout,
              });
              const answer = await new Promise<string>((resolve) => {
                rl.question(
                  `Wipe conversation "${title}" and revert all memory changes? (y/N) `,
                  resolve,
                );
              });
              rl.close();
              if (answer.toLowerCase() !== "y") {
                log.info("Cancelled");
                return;
              }
            }

            const r = await cliIpcCall<{
              wiped: boolean;
              unsupersededItems: number;
              deletedSummaries: number;
              cancelledJobs: number;
            }>("wipeConversation", { pathParams: { id: conversationId } });
            if (!r.ok) {
              log.error(
                `Wipe failed: ${r.error}. Run 'assistant conversations list' to verify the conversation exists.`,
              );
              process.exitCode = 1;
              return;
            }
            const result = r.result!;
            log.info(
              `Wiped conversation (${conversationId}). ` +
                `Restored ${result.unsupersededItems} memory items, ` +
                `deleted ${result.deletedSummaries} summaries, ` +
                `cancelled ${result.cancelledJobs} jobs.`,
            );
          } catch (err) {
            log.error(
              `Error: ${err instanceof Error ? err.message : String(err)}`,
            );
            process.exitCode = 1;
          }
        });

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
              // Conversation exists but stayed busy past the wait-until-idle
              // window. This is a transient condition, not an error — the
              // caller can retry later. Exit 0.
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
