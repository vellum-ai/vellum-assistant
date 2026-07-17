import type { Command } from "commander";

import { cliIpcCall } from "../../ipc/cli-client.js";
import { subcommand } from "../lib/cli-command-help.js";
import { log } from "../logger.js";
import { resolveConversationId } from "../utils/conversation-id.js";
import { parseDuration } from "../utils/parse-duration.js";

export { parseDuration };

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerConversationsDeferCommand(parent: Command): void {
  const defer = subcommand(parent, "defer");

  defer.action(
    async (
      conversationIdArg: string | undefined,
      opts: {
        in?: string;
        at?: string;
        hint?: string;
        name: string;
        json?: boolean;
      },
    ) => {
      let conversationId: string;
      try {
        conversationId = resolveConversationId({
          explicit: conversationIdArg,
          failureHelp:
            "No conversation ID provided. Pass it as an argument, or set $__SKILL_CONTEXT_JSON or $__CONVERSATION_ID.",
        });
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

      if (!opts.hint) {
        const msg = "--hint is required when creating a deferred wake";
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

  subcommand(defer, "list").action(
    async (opts: { conversationId?: string; json?: boolean }) => {
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
    },
  );

  // -----------------------------------------------------------------------
  // defer cancel
  // -----------------------------------------------------------------------

  subcommand(defer, "cancel").action(
    async (
      deferId: string | undefined,
      opts: { all?: boolean; conversationId?: string; json?: boolean },
    ) => {
      if (!deferId && !opts.all) {
        const msg = "Provide a defer ID to cancel, or use --all to cancel all";
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

      const result = await cliIpcCall<{ cancelled: number }>("defer_cancel", {
        body: ipcParams,
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

      const { cancelled } = result.result!;
      if (opts.json) {
        log.info(JSON.stringify({ ok: true, cancelled }));
      } else {
        log.info(`Cancelled ${cancelled} deferred wake(s)`);
      }
    },
  );
}
