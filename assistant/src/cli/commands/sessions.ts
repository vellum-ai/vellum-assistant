import type { Command } from "commander";

import { getQdrantUrlEnv } from "../../config/env.js";
import { getConfig } from "../../config/loader.js";
import { shouldAutoStartDaemon } from "../../daemon/connection-policy.js";
import { ensureDaemonRunning } from "../../daemon/lifecycle.js";
import { formatJson, formatMarkdown } from "../../export/formatter.js";
import {
  clearAll as clearAllConversations,
  createConversation,
  getConversation,
  getMessages,
} from "../../memory/conversation-crud.js";
import { listConversations } from "../../memory/conversation-queries.js";
import { initQdrantClient } from "../../memory/qdrant-client.js";
import { timeAgo } from "../../util/time.js";
import { initializeDb } from "../db.js";
import { log } from "../logger.js";

export function registerSessionsCommand(program: Command): void {
  const sessions = program.command("sessions").description("Manage sessions");

  sessions.addHelpText(
    "after",
    `
Sessions represent conversation threads with the assistant. Each session has a
unique ID and a title. The assistant must be running for "new" (it communicates
via the HTTP API), while "list", "export", and "clear" operate on the local
SQLite database directly.

Examples:
  $ assistant sessions list
  $ assistant sessions new "Project planning"
  $ assistant sessions export
  $ assistant sessions clear`,
  );

  sessions
    .command("list")
    .description("List all sessions")
    .addHelpText(
      "after",
      `
Shows all sessions with their ID, title, and a relative timestamp (e.g.
"3 hours ago"). Sessions are listed in order of most recently updated.

Operates on the local SQLite database directly — does not require the assistant.

Examples:
  $ assistant sessions list`,
    )
    .action(async () => {
      initializeDb();
      const all = listConversations(Number.MAX_SAFE_INTEGER);
      if (all.length === 0) {
        log.info("No sessions");
      } else {
        for (const s of all) {
          log.info(`  ${s.id}  ${s.title ?? "Untitled"}  ${timeAgo(s.updatedAt)}`);
        }
      }
    });

  sessions
    .command("new [title]")
    .description("Create a new session")
    .addHelpText(
      "after",
      `
Arguments:
  title   Optional session title (string). If omitted, a default title is
          assigned by the assistant.

Creates a new conversation session and prints its title and ID.

Examples:
  $ assistant sessions new
  $ assistant sessions new "Project planning"
  $ assistant sessions new "Bug triage 2026-03-05"`,
    )
    .action(async (title?: string) => {
      if (shouldAutoStartDaemon()) await ensureDaemonRunning();
      initializeDb();
      const conversation = createConversation(title);
      log.info(
        `Created session: ${conversation.title ?? "New Conversation"} (${conversation.id})`,
      );
    });

  sessions
    .command("export [sessionId]")
    .description("Export a conversation as markdown or JSON")
    .option("-f, --format <format>", "Output format: md or json", "md")
    .option("-o, --output <file>", "Write to file instead of stdout")
    .addHelpText(
      "after",
      `
Arguments:
  sessionId   Optional session ID (or unique prefix). Defaults to the most
              recent session. Supports prefix matching — e.g. "abc123" matches
              the first session whose ID starts with "abc123".

Two output formats are available:
  md    Markdown conversation transcript (default). Human-readable rendering
        of messages with role headers.
  json  Structured JSON export with full metadata, message content arrays,
        and timestamps.

Operates on the local SQLite database directly — does not require the assistant.

Examples:
  $ assistant sessions export
  $ assistant sessions export --format json -o conversation.json
  $ assistant sessions export abc123 --format md`,
    )
    .action(
      async (
        sessionId?: string,
        opts?: { format: string; output?: string },
      ) => {
        initializeDb();
        const format = opts?.format ?? "md";
        if (format !== "md" && format !== "json") {
          log.error('Error: format must be "md" or "json"');
          process.exit(1);
        }

        let id = sessionId;
        if (!id) {
          const all = listConversations(1);
          if (all.length === 0) {
            log.error("No sessions found");
            process.exit(1);
          }
          id = all[0].id;
        }

        // Support prefix matching for session IDs
        let conversation = getConversation(id);
        if (!conversation) {
          const all = listConversations(Number.MAX_SAFE_INTEGER);
          const match = all.find((c) => c.id.startsWith(id!));
          if (match) {
            conversation = match;
          } else {
            log.error(`Session not found: ${id}`);
            process.exit(1);
          }
        }

        const msgs = getMessages(conversation.id);
        const exportData = {
          ...conversation,
          messages: msgs.map((m) => ({
            role: m.role,
            content: JSON.parse(m.content),
            createdAt: m.createdAt,
          })),
        };

        const output =
          format === "json"
            ? formatJson(exportData)
            : formatMarkdown(exportData);

        if (opts?.output) {
          const { writeFileSync } = await import("node:fs");
          writeFileSync(opts.output, output);
          log.info(`Exported to ${opts.output}`);
        } else {
          process.stdout.write(output);
        }
      },
    );

  sessions
    .command("clear")
    .description(
      "Clear all conversations, messages, and vector data (dev only)",
    )
    .addHelpText(
      "after",
      `
Permanently deletes ALL conversations, messages, and Qdrant vector data.
Prompts for confirmation (y/N) before proceeding. After clearing the local
database, the running assistant (if any) will pick up the changes on the next
request.

Operates on the local SQLite database and Qdrant directly — does not require
the assistant.

Intended for development use. This action cannot be undone.

Examples:
  $ assistant sessions clear`,
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

      initializeDb();
      const result = clearAllConversations();
      log.info(
        `Cleared ${result.conversations} conversations, ${result.messages} messages`,
      );

      const config = getConfig();
      const qdrantUrl = getQdrantUrlEnv() || config.memory.qdrant.url;
      const qdrant = initQdrantClient({
        url: qdrantUrl,
        collection: config.memory.qdrant.collection,
        vectorSize: config.memory.qdrant.vectorSize,
        onDisk: config.memory.qdrant.onDisk,
        quantization: config.memory.qdrant.quantization,
      });
      const deleted = await qdrant.deleteCollection();
      if (deleted) {
        log.info(
          `Deleted Qdrant collection "${config.memory.qdrant.collection}"`,
        );
      } else {
        log.info("Qdrant collection not found or not reachable (skipped)");
      }

      log.info("Done.");
    });
}
