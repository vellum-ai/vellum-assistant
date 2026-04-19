/**
 * `assistant task` CLI namespace.
 *
 * Subcommands: save, list, run, delete — thin wrappers over the daemon's
 * task IPC routes (`task/save`, `task/list`, `task/run`, `task/delete`).
 */

import type { Command } from "commander";

import { cliIpcCall } from "../../ipc/cli-client.js";
import { log } from "../logger.js";

// ── Conversation ID resolution ────────────────────────────────────────

/**
 * Resolve conversation ID from CLI execution context.
 *
 * Precedence:
 *   1. Explicit `--conversation-id` option
 *   2. `__SKILL_CONTEXT_JSON.conversationId`
 *   3. `__CONVERSATION_ID`
 *
 * Returns undefined when no source is available.
 */
function resolveConversationId(
  explicit: string | undefined,
): string | undefined {
  if (explicit && explicit.length > 0) {
    return explicit;
  }

  const contextJson = process.env.__SKILL_CONTEXT_JSON;
  if (contextJson) {
    try {
      const parsed = JSON.parse(contextJson) as { conversationId?: unknown };
      if (
        typeof parsed.conversationId === "string" &&
        parsed.conversationId.length > 0
      ) {
        return parsed.conversationId;
      }
    } catch {
      // Ignore malformed skill context and fall through.
    }
  }

  const envConversationId = process.env.__CONVERSATION_ID;
  if (envConversationId && envConversationId.length > 0) {
    return envConversationId;
  }

  return undefined;
}

// ── Registration ──────────────────────────────────────────────────────

export function registerTaskCommand(program: Command): void {
  const task = program
    .command("task")
    .description("Manage task templates and the task queue");

  // ── save ─────────────────────────────────────────────────────────

  task
    .command("save")
    .description("Save the current conversation as a task template")
    .option("--conversation-id <id>", "Conversation ID to save as a template")
    .option("--title <title>", "Title for the task template")
    .option("--json", "Output result as machine-readable JSON.")
    .action(
      async (opts: {
        conversationId?: string;
        title?: string;
        json?: boolean;
      }) => {
        const conversation_id = resolveConversationId(opts.conversationId);

        if (!conversation_id) {
          const msg =
            "No conversation ID provided. Use --conversation-id or run from a skill context.";
          if (opts.json) {
            process.stdout.write(
              JSON.stringify({ ok: false, error: msg }) + "\n",
            );
          } else {
            log.error(msg);
          }
          process.exitCode = 1;
          return;
        }

        const params: Record<string, unknown> = { conversation_id };
        if (opts.title) params.title = opts.title;

        const result = await cliIpcCall<{ task_id: string; title: string }>(
          "task/save",
          params,
        );

        if (!result.ok) {
          if (opts.json) {
            process.stdout.write(
              JSON.stringify({ ok: false, error: result.error }) + "\n",
            );
          } else {
            log.error(`Error: ${result.error}`);
          }
          process.exitCode = 1;
          return;
        }

        if (opts.json) {
          process.stdout.write(
            JSON.stringify({ ok: true, ...result.result }) + "\n",
          );
        } else {
          log.info(
            `Task template saved: ${result.result!.title} (${result.result!.task_id})`,
          );
        }
      },
    );

  // ── list ─────────────────────────────────────────────────────────

  task
    .command("list")
    .description("List all task templates")
    .option("--json", "Output result as machine-readable JSON.")
    .action(async (opts: { json?: boolean }) => {
      const result = await cliIpcCall<{ tasks: unknown[] }>("task/list");

      if (!result.ok) {
        if (opts.json) {
          process.stdout.write(
            JSON.stringify({ ok: false, error: result.error }) + "\n",
          );
        } else {
          log.error(`Error: ${result.error}`);
        }
        process.exitCode = 1;
        return;
      }

      if (opts.json) {
        process.stdout.write(
          JSON.stringify({ ok: true, tasks: result.result!.tasks }) + "\n",
        );
      } else {
        const tasks = result.result!.tasks;
        if (tasks.length === 0) {
          log.info("No task templates found.");
        } else {
          log.info(JSON.stringify(tasks, null, 2));
        }
      }
    });

  // ── run ──────────────────────────────────────────────────────────

  task
    .command("run")
    .description("Run a task template")
    .option("--id <id>", "Task template ID to run")
    .option("--name <name>", "Task template name to run")
    .option("--inputs <json>", "JSON object of template inputs")
    .option("--json", "Output result as machine-readable JSON.")
    .action(
      async (opts: {
        id?: string;
        name?: string;
        inputs?: string;
        json?: boolean;
      }) => {
        const params: Record<string, unknown> = {};
        if (opts.id) params.task_id = opts.id;
        if (opts.name) params.task_name = opts.name;

        if (opts.inputs) {
          try {
            params.inputs = JSON.parse(opts.inputs);
          } catch {
            const msg = `Invalid JSON for --inputs: ${opts.inputs}`;
            if (opts.json) {
              process.stdout.write(
                JSON.stringify({ ok: false, error: msg }) + "\n",
              );
            } else {
              log.error(msg);
            }
            process.exitCode = 1;
            return;
          }
        }

        const result = await cliIpcCall<Record<string, unknown>>(
          "task/run",
          params,
        );

        if (!result.ok) {
          if (opts.json) {
            process.stdout.write(
              JSON.stringify({ ok: false, error: result.error }) + "\n",
            );
          } else {
            log.error(`Error: ${result.error}`);
          }
          process.exitCode = 1;
          return;
        }

        if (opts.json) {
          process.stdout.write(
            JSON.stringify({ ok: true, ...result.result }) + "\n",
          );
        } else {
          log.info("Task started successfully.");
          if (result.result) {
            log.info(JSON.stringify(result.result, null, 2));
          }
        }
      },
    );

  // ── delete ───────────────────────────────────────────────────────

  task
    .command("delete <ids...>")
    .description("Delete one or more task templates")
    .option("--json", "Output result as machine-readable JSON.")
    .action(async (ids: string[], opts: { json?: boolean }) => {
      const result = await cliIpcCall<{ deleted: number }>("task/delete", {
        task_ids: ids,
      });

      if (!result.ok) {
        if (opts.json) {
          process.stdout.write(
            JSON.stringify({ ok: false, error: result.error }) + "\n",
          );
        } else {
          log.error(`Error: ${result.error}`);
        }
        process.exitCode = 1;
        return;
      }

      if (opts.json) {
        process.stdout.write(
          JSON.stringify({ ok: true, deleted: result.result!.deleted }) + "\n",
        );
      } else {
        log.info(`Deleted ${result.result!.deleted} task template(s).`);
      }
    });
}
