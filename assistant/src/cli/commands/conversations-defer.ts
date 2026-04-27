import type { Command } from "commander";

import { cliIpcCall } from "../../ipc/cli-client.js";
import { log } from "../logger.js";

// ---------------------------------------------------------------------------
// Duration parser
// ---------------------------------------------------------------------------

/**
 * Parse a human-friendly duration string into seconds.
 *
 * Accepted formats:
 *   "60"     → 60   (bare number = seconds)
 *   "60s"    → 60
 *   "5m"     → 300
 *   "1h"     → 3600
 *   "1h30m"  → 5400
 *   "90s"    → 90
 */
export function parseDuration(input: string): number {
  if (/^\d+$/.test(input)) return parseInt(input, 10);

  let total = 0;
  const re = /(\d+)(h|m|s)/g;
  let match;
  while ((match = re.exec(input)) !== null) {
    const val = parseInt(match[1], 10);
    switch (match[2]) {
      case "h":
        total += val * 3600;
        break;
      case "m":
        total += val * 60;
        break;
      case "s":
        total += val;
        break;
    }
  }
  if (total === 0) throw new Error(`Invalid duration: "${input}"`);
  return total;
}

// ---------------------------------------------------------------------------
// Conversation ID resolution
// ---------------------------------------------------------------------------

function resolveConversationId(positionalArg?: string): string {
  if (positionalArg) return positionalArg;

  const skillCtxRaw = process.env.__SKILL_CONTEXT_JSON;
  if (skillCtxRaw) {
    try {
      const ctx = JSON.parse(skillCtxRaw) as Record<string, unknown>;
      if (typeof ctx.conversationId === "string" && ctx.conversationId) {
        return ctx.conversationId;
      }
    } catch {
      // Ignore malformed JSON
    }
  }

  const envConvId = process.env.__CONVERSATION_ID;
  if (envConvId) return envConvId;

  throw new Error(
    "No conversation ID provided. Pass it as an argument, or set $__SKILL_CONTEXT_JSON or $__CONVERSATION_ID.",
  );
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerConversationsDeferCommand(parent: Command): void {
  const defer = parent
    .command("defer [conversationId]")
    .description("Create a deferred wake for a conversation")
    .option("--in <duration>", "Delay before firing (e.g. 60, 60s, 5m, 1h)")
    .option("--at <iso8601>", "Absolute ISO 8601 fire time")
    .requiredOption("--hint <text>", "Hint message for the wake")
    .option("--name <text>", "Name for the deferred wake", "Deferred wake")
    .option("--json", "Output result as JSON")
    .addHelpText(
      "after",
      `
Create a deferred wake that fires after a delay or at a specific time.
The conversation ID is resolved from the positional argument, the
$__SKILL_CONTEXT_JSON env var, or $__CONVERSATION_ID.

Requires the assistant to be running. Communicates via IPC socket.

Examples:
  $ assistant conversations defer --in 60 --hint "check progress"
  $ assistant conversations defer conv-123 --in 5m --hint "follow up"
  $ assistant conversations defer --at 2026-04-23T15:00:00Z --hint "meeting time"
  $ assistant conversations defer --in 1h30m --hint "remind me" --json`,
    )
    .action(
      async (
        conversationIdArg: string | undefined,
        opts: {
          in?: string;
          at?: string;
          hint: string;
          name: string;
          json?: boolean;
        },
      ) => {
        let conversationId: string;
        try {
          conversationId = resolveConversationId(conversationIdArg);
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

        if (!opts.in && !opts.at) {
          const msg = "Either --in or --at must be provided";
          if (opts.json) {
            log.info(JSON.stringify({ ok: false, error: msg }));
          } else {
            log.error(`Error: ${msg}`);
          }
          process.exitCode = 1;
          return;
        }

        let delaySeconds: number | undefined;
        let fireAt: number | undefined;

        if (opts.in) {
          try {
            delaySeconds = parseDuration(opts.in);
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
        }

        if (opts.at) {
          fireAt = new Date(opts.at).getTime();
          if (isNaN(fireAt)) {
            const msg = `Invalid ISO 8601 date: "${opts.at}"`;
            if (opts.json) {
              log.info(JSON.stringify({ ok: false, error: msg }));
            } else {
              log.error(`Error: ${msg}`);
            }
            process.exitCode = 1;
            return;
          }
          if (fireAt <= Date.now()) {
            const msg = "The --at time must be in the future";
            if (opts.json) {
              log.info(JSON.stringify({ ok: false, error: msg }));
            } else {
              log.error(`Error: ${msg}`);
            }
            process.exitCode = 1;
            return;
          }
        }

        const result = await cliIpcCall<{
          id: string;
          name: string;
          fireAt: number;
          conversationId: string;
        }>("defer_create", {
          body: {
            conversationId,
            hint: opts.hint,
            delaySeconds,
            fireAt,
            name: opts.name,
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

        const created = result.result!;
        if (opts.json) {
          log.info(JSON.stringify({ ok: true, ...created }));
        } else {
          const fireDate = new Date(created.fireAt).toISOString();
          log.info(
            `Created deferred wake "${created.name}" (${created.id}) — fires at ${fireDate}`,
          );
        }
      },
    );

  // -----------------------------------------------------------------------
  // defer list
  // -----------------------------------------------------------------------

  defer
    .command("list")
    .description("List pending deferred wakes")
    .option("--conversation-id <id>", "Filter by conversation ID")
    .option("--json", "Output result as JSON")
    .addHelpText(
      "after",
      `
List all pending deferred wakes, optionally filtered by conversation ID.

Requires the assistant to be running. Communicates via IPC socket.

Examples:
  $ assistant conversations defer list
  $ assistant conversations defer list --conversation-id conv-123
  $ assistant conversations defer list --json`,
    )
    .action(async (opts: { conversationId?: string; json?: boolean }) => {
      const result = await cliIpcCall<{
        defers: Array<{
          id: string;
          name: string;
          hint: string;
          conversationId: string;
          fireAt: number;
          status: string;
        }>;
      }>("defer_list", {
        body: { conversationId: opts.conversationId },
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

      const { defers } = result.result!;

      if (opts.json) {
        log.info(JSON.stringify({ ok: true, defers }));
        return;
      }

      if (defers.length === 0) {
        log.info("No pending deferred wakes");
        return;
      }

      log.info(`${"ID".padEnd(38)}${"Fire At".padEnd(28)}Hint`);
      log.info("-".repeat(80));
      for (const d of defers) {
        const fireDate = new Date(d.fireAt).toISOString();
        log.info(`${d.id.padEnd(38)}${fireDate.padEnd(28)}${d.hint}`);
      }
    });

  // -----------------------------------------------------------------------
  // defer cancel
  // -----------------------------------------------------------------------

  defer
    .command("cancel [deferId]")
    .description("Cancel a deferred wake by ID, or all with --all")
    .option("--all", "Cancel all pending deferred wakes")
    .option("--conversation-id <id>", "Filter by conversation ID (with --all)")
    .option("--json", "Output result as JSON")
    .addHelpText(
      "after",
      `
Cancel a single deferred wake by ID, or all pending wakes with --all.

Requires the assistant to be running. Communicates via IPC socket.

Examples:
  $ assistant conversations defer cancel <deferId>
  $ assistant conversations defer cancel --all
  $ assistant conversations defer cancel --all --conversation-id conv-123
  $ assistant conversations defer cancel --all --json`,
    )
    .action(
      async (
        deferId: string | undefined,
        opts: { all?: boolean; conversationId?: string; json?: boolean },
      ) => {
        if (!deferId && !opts.all) {
          const msg =
            "Provide a defer ID to cancel, or use --all to cancel all";
          if (opts.json) {
            log.info(JSON.stringify({ ok: false, error: msg }));
          } else {
            log.error(`Error: ${msg}`);
          }
          process.exitCode = 1;
          return;
        }

        const ipcParams: Record<string, unknown> = {};
        if (deferId) {
          ipcParams.id = deferId;
        }
        if (opts.all) {
          ipcParams.all = true;
          if (opts.conversationId) {
            ipcParams.conversationId = opts.conversationId;
          }
        }

        const result = await cliIpcCall<{ cancelled: number }>(
          "defer_cancel",
          { body: ipcParams },
        );

        if (!result.ok) {
          if (opts.json) {
            log.info(JSON.stringify({ ok: false, error: result.error }));
          } else {
            log.error(`Error: ${result.error}`);
          }
          process.exitCode = 1;
          return;
        }

        const { cancelled } = result.result!;
        if (opts.json) {
          log.info(JSON.stringify({ ok: true, cancelled }));
        } else {
          log.info(`Cancelled ${cancelled} deferred wake(s)`);
        }
      },
    );
}
