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

// ── IPC result shape ──────────────────────────────────────────────────

/** All task IPC handlers return `{ ok, content }` with a human-readable string. */
interface TaskIpcResult {
  ok: boolean;
  content: string;
}

// ── Registration ──────────────────────────────────────────────────────

export function registerTaskCommand(program: Command): void {
  const task = program
    .command("task")
    .description("Manage task templates and the task queue");

  task.addHelpText(
    "after",
    `
Task templates capture a conversation as a reusable recipe that can be
re-run later with optional input overrides. Templates are stored on disk
in the assistant's workspace and identified by an auto-generated ID and
a human-readable title.

Examples:
  $ assistant task save --conversation-id conv_abc123 --title "Deploy staging"
  $ assistant task list
  $ assistant task run --name "Deploy staging"
  $ assistant task delete tmpl_abc123`,
  );

  // ── save ─────────────────────────────────────────────────────────

  task
    .command("save")
    .description("Save the current conversation as a task template")
    .option(
      "--conversation-id <id>",
      "Conversation ID to save as a template — run 'assistant conversations list' to find it",
    )
    .option("--title <title>", "Title for the task template")
    .option("--json", "Output result as machine-readable JSON.")
    .addHelpText(
      "after",
      `
Captures the referenced conversation as a task template. If --title is
omitted, the assistant derives one from the conversation content. The
conversation ID is resolved in order: --conversation-id flag, then the
__SKILL_CONTEXT_JSON env var, then __CONVERSATION_ID env var.

Arguments:
  (none — uses options below)

Options:
  --conversation-id <id>  Conversation to snapshot. Run 'assistant conversations list' to find it.
  --title <title>         Human-readable name for the template (auto-derived if omitted).
  --json                  Output as JSON: { "ok": true, "content": "..." }

Examples:
  $ assistant task save --conversation-id conv_abc123
  $ assistant task save --conversation-id conv_abc123 --title "Deploy staging"
  $ assistant task save --json`,
    )
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

        const result = await cliIpcCall<TaskIpcResult>("task/save", params);

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
            JSON.stringify({ ok: true, content: result.result!.content }) +
              "\n",
          );
        } else {
          log.info(result.result!.content);
        }
      },
    );

  // ── list ─────────────────────────────────────────────────────────

  task
    .command("list")
    .description("List all task templates")
    .option("--json", "Output result as machine-readable JSON.")
    .addHelpText(
      "after",
      `
Lists all saved task templates with their IDs and titles. In non-JSON
mode the output is human-readable text from the daemon. In --json mode
the raw content string is returned.

Arguments:
  (none)

Examples:
  $ assistant task list
  $ assistant task list --json`,
    )
    .action(async (opts: { json?: boolean }) => {
      const result = await cliIpcCall<TaskIpcResult>("task/list");

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
          JSON.stringify({ ok: true, content: result.result!.content }) + "\n",
        );
      } else {
        log.info(result.result!.content);
      }
    });

  // ── run ──────────────────────────────────────────────────────────

  task
    .command("run")
    .description("Run a task template")
    .option(
      "--id <id>",
      "Task template ID to run — run 'assistant task list' to find it",
    )
    .option(
      "--name <name>",
      "Task template name to run — run 'assistant task list' to find it",
    )
    .option("--inputs <json>", "JSON object of template inputs")
    .option("--json", "Output result as machine-readable JSON.")
    .addHelpText(
      "after",
      `
Executes a saved task template by ID or name. Provide --id or --name
(at least one required). Optional --inputs supplies a JSON object of
key/value overrides for the template.

Arguments:
  (none — uses options below)

Options:
  --id <id>         Template ID. Run 'assistant task list' to find it.
  --name <name>     Template name. Run 'assistant task list' to find it.
  --inputs <json>   JSON object of input overrides, e.g. '{"branch":"main"}'.
  --json            Output as JSON: { "ok": true, "content": "..." }

Examples:
  $ assistant task run --name "Deploy staging"
  $ assistant task run --id tmpl_abc123 --inputs '{"env":"production"}'
  $ assistant task run --name "Deploy staging" --json`,
    )
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

        const result = await cliIpcCall<TaskIpcResult>("task/run", params);

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
            JSON.stringify({ ok: true, content: result.result!.content }) +
              "\n",
          );
        } else {
          log.info(result.result!.content);
        }
      },
    );

  // ── delete ───────────────────────────────────────────────────────

  task
    .command("delete <ids...>")
    .description("Delete one or more task templates")
    .option("--json", "Output result as machine-readable JSON.")
    .addHelpText(
      "after",
      `
Removes one or more task templates by their IDs. Accepts multiple IDs
separated by spaces. Deletion is permanent.

Arguments:
  ids   One or more template IDs to delete. Run 'assistant task list' to find them.

Examples:
  $ assistant task delete tmpl_abc123
  $ assistant task delete tmpl_abc123 tmpl_def456
  $ assistant task delete tmpl_abc123 --json`,
    )
    .action(async (ids: string[], opts: { json?: boolean }) => {
      const result = await cliIpcCall<TaskIpcResult>("task/delete", {
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
          JSON.stringify({ ok: true, content: result.result!.content }) + "\n",
        );
      } else {
        log.info(result.result!.content);
      }
    });
}
