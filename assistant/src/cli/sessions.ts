import type { Command } from "commander";

import { getQdrantUrlEnv } from "../config/env.js";
import { getConfig } from "../config/loader.js";
import { shouldAutoStartDaemon } from "../daemon/connection-policy.js";
import { ensureDaemonRunning } from "../daemon/lifecycle.js";
import { formatJson, formatMarkdown } from "../export/formatter.js";
import {
  clearAll as clearAllConversations,
  getConversation,
  getMessages,
  listConversations,
} from "../memory/conversation-store.js";
import { initializeDb } from "../memory/db.js";
import { initQdrantClient } from "../memory/qdrant-client.js";
import { getCliLogger } from "../util/logger.js";
import { timeAgo } from "../util/time.js";
import { sendOneMessage } from "./ipc-client.js";

const log = getCliLogger("cli");

export function registerSessionsCommand(program: Command): void {
  const sessions = program.command("sessions").description("Manage sessions");

  sessions
    .command("list")
    .description("List all sessions")
    .action(async () => {
      if (shouldAutoStartDaemon()) await ensureDaemonRunning();
      const response = await sendOneMessage({ type: "session_list" });
      if (response.type === "session_list_response") {
        if (response.sessions.length === 0) {
          log.info("No sessions");
        } else {
          for (const s of response.sessions) {
            log.info(`  ${s.id}  ${s.title}  ${timeAgo(s.updatedAt)}`);
          }
        }
      } else if (response.type === "error") {
        log.error(`Error: ${response.message}`);
      }
    });

  sessions
    .command("new [title]")
    .description("Create a new session")
    .action(async (title?: string) => {
      if (shouldAutoStartDaemon()) await ensureDaemonRunning();
      const response = await sendOneMessage({
        type: "session_create",
        title,
      });
      if (response.type === "session_info") {
        log.info(`Created session: ${response.title} (${response.sessionId})`);
      } else if (response.type === "error") {
        log.error(`Error: ${response.message}`);
      }
    });

  sessions
    .command("export [sessionId]")
    .description("Export a conversation as markdown or JSON")
    .option("-f, --format <format>", "Output format: md or json", "md")
    .option("-o, --output <file>", "Write to file instead of stdout")
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

      // Notify a running daemon to drop its in-memory sessions so it
      // doesn't keep serving stale history from deleted conversation rows.
      try {
        await sendOneMessage({ type: "sessions_clear" });
      } catch {
        // Daemon may not be running — that's fine, no sessions to invalidate.
      }

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
