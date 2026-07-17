import { existsSync, readFileSync } from "node:fs";

import type { Command } from "commander";

import {
  cliIpcCall,
  exitCodeFromIpcResult,
  exitFromIpcResult,
} from "../../ipc/cli-client.js";
import { applyCommandHelp, subcommand } from "../lib/cli-command-help.js";
import { registerCommand } from "../lib/register-command.js";
import { timeAgo } from "../lib/time-ago.js";
import { log } from "../logger.js";
import { tryResolveConversationId } from "../utils/conversation-id.js";
import { conversationsHelp } from "./conversations.help.js";
import { registerConversationsDeferCommand } from "./conversations-defer.js";
import { registerConversationsImportCommand } from "./conversations-import.js";

type ConversationSeedMessage = {
  role: "user" | "assistant";
  content: string;
};

type SlackDetachCliResult = {
  detached: boolean;
  channelId: string;
  threadTs: string;
  source: "explicit" | "conversation_binding";
  conversationId?: string;
};

function outputSlackDetachError(message: string, json?: boolean): void {
  if (json) {
    process.stdout.write(JSON.stringify({ ok: false, error: message }) + "\n");
  } else {
    log.error(`Error: ${message}`);
  }
  process.exitCode = 1;
}

// Returns the parsed seed messages (or `undefined` when no file is given), or a
// validation error for the caller to surface — human or `--json`. The caller
// owns output/exit so the error shape matches the rest of the command.
type SeedResult =
  | { messages: ConversationSeedMessage[] | undefined }
  | { error: string };

function readSeedMessages(contentFile?: string): SeedResult {
  if (!contentFile) return { messages: undefined };
  if (!existsSync(contentFile)) {
    return { error: `content file not found: ${contentFile}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(contentFile, "utf-8"));
  } catch (err) {
    return {
      error: `failed to read content file: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!Array.isArray(parsed)) {
    return { error: "content file must contain an array of messages" };
  }

  const messages: ConversationSeedMessage[] = [];
  for (const [index, value] of parsed.entries()) {
    if (
      typeof value !== "object" ||
      value === null ||
      !("role" in value) ||
      !("content" in value)
    ) {
      return { error: `message ${index} must include role and content` };
    }
    const role = (value as { role?: unknown }).role;
    const content = (value as { content?: unknown }).content;
    if (
      (role !== "user" && role !== "assistant") ||
      typeof content !== "string"
    ) {
      return {
        error: `message ${index} must have role user|assistant and string content`,
      };
    }
    messages.push({ role, content });
  }

  return { messages };
}

async function createConversationCli(
  title: string | undefined,
  opts?: { contentFile?: string; json?: boolean },
): Promise<void> {
  // Seed-file errors happen before any IPC — surface them in JSON mode too.
  const seed = readSeedMessages(opts?.contentFile);
  if ("error" in seed) {
    if (opts?.json) {
      log.info(JSON.stringify({ ok: false, error: seed.error }));
    } else {
      log.error(`Error: ${seed.error}`);
    }
    process.exitCode = 1;
    return;
  }
  const messages = seed.messages;

  // A script-mode schedule injects __SCHEDULE_RUN_ID into its env (see
  // schedule/run-script.ts). When set, create the conversation as `scheduled`
  // so script-mode runs are routed to the Scheduled section instead of
  // cluttering the main sidebar.
  const scheduleRunId = process.env.__SCHEDULE_RUN_ID;

  const result = await cliIpcCall<{
    id: string;
    title: string;
    conversationKey: string;
    messagesInserted: number;
  }>("conversation_create_cli", {
    body: {
      title,
      messages,
      ...(scheduleRunId ? { conversationType: "scheduled" } : {}),
    },
  });

  if (!result.ok) {
    if (opts?.json) {
      log.info(JSON.stringify({ ok: false, error: result.error }));
      process.exitCode = 1;
      return;
    }
    return exitFromIpcResult(result);
  }

  const conversation = result.result!;
  // JSON output so callers can capture the new id programmatically.
  if (opts?.json) {
    log.info(JSON.stringify({ ok: true, ...conversation }));
    return;
  }
  const seedSuffix = conversation.messagesInserted
    ? `, seeded ${conversation.messagesInserted} messages`
    : "";
  log.info(
    `Created conversation: ${conversation.title} (${conversation.id}), conversation key: ${conversation.conversationKey}${seedSuffix}`,
  );
}

export function registerConversationsCommand(program: Command): void {
  registerCommand(program, {
    name: conversationsHelp.name,
    transport: "ipc",
    description: conversationsHelp.description,
    build: (conversations) => {
      applyCommandHelp(conversations, conversationsHelp);

      registerConversationsImportCommand(conversations);
      registerConversationsDeferCommand(conversations);

      // -------------------------------------------------------------------
      // list
      // -------------------------------------------------------------------

      subcommand(conversations, "list").action(
        async (opts?: { includeArchived?: boolean }) => {
          const result = await cliIpcCall<{
            conversations: Array<{
              id: string;
              title: string | null;
              updatedAt: number;
              isProcessing: boolean;
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
              // "●" marks a conversation whose agent loop is mid-turn;
              // a single space keeps idle rows aligned without padding
              // every line with the marker glyph.
              const marker = s.isProcessing ? "●" : " ";
              log.info(
                `  ${marker} ${s.id}  ${s.title ?? "Untitled"}  ${timeAgo(s.updatedAt)}`,
              );
            }
          }
        },
      );

      // -------------------------------------------------------------------
      // new
      // -------------------------------------------------------------------

      subcommand(conversations, "new").action(createConversationCli);

      // -------------------------------------------------------------------
      // rename
      // -------------------------------------------------------------------

      subcommand(conversations, "rename").action(
        async (conversationId: string, title: string) => {
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
        },
      );

      // -------------------------------------------------------------------
      // export
      // -------------------------------------------------------------------

      subcommand(conversations, "export").action(
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
      // slack
      // -------------------------------------------------------------------

      const slack = subcommand(conversations, "slack");

      // The "mute" alias is not expressible in CliCommandHelp, so it is
      // applied imperatively on top of the declared subcommand.
      subcommand(slack, "detach")
        .alias("mute")
        .action(
          async (
            conversationIdArg: string | undefined,
            opts: { channel?: string; thread?: string; json?: boolean },
          ) => {
            const channelId = opts.channel?.trim();
            const threadTs = opts.thread?.trim();
            const hasExplicitSlackTarget =
              opts.channel !== undefined || opts.thread !== undefined;
            const body: Record<string, string> = {};

            if (hasExplicitSlackTarget) {
              if (!channelId || !threadTs) {
                outputSlackDetachError(
                  "Both --channel and --thread are required when using explicit Slack identifiers.",
                  opts.json,
                );
                return;
              }
              body.channelId = channelId;
              body.threadTs = threadTs;
            } else {
              const conversationId = tryResolveConversationId({
                explicit: conversationIdArg,
              });
              if (!conversationId) {
                outputSlackDetachError(
                  "No conversation ID available. Pass a conversation ID, provide --channel and --thread, or run this command from a skill or bash tool context.",
                  opts.json,
                );
                return;
              }
              body.conversationId = conversationId;
            }

            const result = await cliIpcCall<SlackDetachCliResult>(
              "conversation_slack_detach_cli",
              { body },
            );

            if (!result.ok) {
              if (opts.json) {
                process.stdout.write(
                  JSON.stringify({
                    ok: false,
                    error: result.error ?? "Failed to detach Slack thread",
                  }) + "\n",
                );
                process.exitCode = exitCodeFromIpcResult(result);
                return;
              }
              return exitFromIpcResult(result);
            }

            const detach = result.result!;
            if (opts.json) {
              process.stdout.write(
                JSON.stringify({ ok: true, result: detach }) + "\n",
              );
              return;
            }

            if (detach.detached) {
              log.info(
                `Detached Slack thread ${detach.threadTs} in channel ${detach.channelId} from assistant listening.`,
              );
            } else {
              log.info(
                `Slack thread ${detach.threadTs} in channel ${detach.channelId} was already detached from assistant listening.`,
              );
            }
          },
        );

      // -------------------------------------------------------------------
      // clear
      // -------------------------------------------------------------------

      subcommand(conversations, "clear").action(async () => {
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
          {
            headers: {
              "x-confirm-destructive": "clear-all-conversations",
            },
          },
        );

        if (!result.ok) return exitFromIpcResult(result);

        log.info(`Cleared ${result.result!.cleared} conversations. Done.`);
      });

      // -------------------------------------------------------------------
      // wake
      // -------------------------------------------------------------------

      subcommand(conversations, "wake").action(
        async (
          conversationId: string,
          opts: {
            hint: string;
            source: string;
            persist?: boolean;
            externalContent?: string;
            json?: boolean;
          },
        ) => {
          // A script-mode schedule injects __SCHEDULE_RUN_ID into its env
          // (see schedule/run-script.ts). When set, thread it through so the
          // woken turn's usage is attributed to the firing.
          const cronRunId = process.env.__SCHEDULE_RUN_ID;

          // Fencing only exists on the persisted-event path, so
          // --external-content implies --persist.
          const externalContent = opts.externalContent;
          const persist = opts.persist || externalContent !== undefined;

          const result = await cliIpcCall<{
            invoked: boolean;
            producedToolCalls: boolean;
            reason?: "not_found" | "archived" | "timeout" | "no_resolver";
          }>("wake_conversation", {
            body: {
              conversationId,
              hint: opts.hint,
              source: opts.source,
              ...(cronRunId ? { cronRunId } : {}),
              ...(persist ? { persist: true } : {}),
              ...(externalContent !== undefined ? { externalContent } : {}),
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
