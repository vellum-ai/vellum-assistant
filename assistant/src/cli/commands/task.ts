/**
 * `assistant task` CLI namespace.
 *
 * Subcommands for task template management (save, list, run, delete) and
 * work queue operations (queue show/add/update/remove/run). All commands
 * are thin wrappers over the assistant's task IPC routes.
 */

import type { Command } from "commander";

import { cliIpcCall } from "../../ipc/cli-client.js";
import { log } from "../logger.js";

// ── Conversation ID resolution ────────────────────────────────────────

/**
 * Resolve the conversation ID by precedence:
 *   1. Explicit `--conversation-id` flag
 *   2. `__SKILL_CONTEXT_JSON` env var (set by skill sandbox runner)
 *   3. `__CONVERSATION_ID` env var (set by bash tool subprocess)
 *   4. Fail with an actionable error
 */
function resolveConversationId(explicit?: string): string {
  if (explicit) return explicit;

  const contextJson = process.env.__SKILL_CONTEXT_JSON;
  if (contextJson) {
    try {
      const parsed = JSON.parse(contextJson);
      if (parsed.conversationId && typeof parsed.conversationId === "string") {
        return parsed.conversationId;
      }
    } catch {
      // Fall through
    }
  }

  const envConvId = process.env.__CONVERSATION_ID;
  if (envConvId && typeof envConvId === "string") {
    return envConvId;
  }

  throw new Error(
    "No conversation ID available.\n" +
      "Provide --conversation-id explicitly (run 'assistant conversations list' to find it),\n" +
      "or run this command from a skill or bash tool context.",
  );
}

// ── Registration ──────────────────────────────────────────────────────

export function registerTaskCommand(program: Command): void {
  const task = program
    .command("task")
    .description("Manage task templates and work queue items");

  task.addHelpText(
    "after",
    `
Task templates define reusable work items that the assistant can execute.
The work queue holds pending, in-progress, and completed work items
derived from task templates.

Examples:
  $ assistant task list
  $ assistant task save --title "Deploy workflow"
  $ assistant task run --name "Deploy workflow"
  $ assistant task queue show --status pending
  $ assistant task queue add --name "Deploy workflow" --title "Deploy v2"`,
  );

  // ── save ──────────────────────────────────────────────────────────

  task
    .command("save")
    .description("Save the current conversation as a task template")
    .option(
      "--conversation-id <id>",
      "Conversation ID to save as a template -- run 'assistant conversations list' to find it. Falls back to env vars.",
    )
    .option("--title <title>", "Title for the task template.")
    .option("--json", "Output result as machine-readable JSON.")
    .addHelpText(
      "after",
      `
Saves the current conversation as a reusable task template. The
conversation ID is resolved from --conversation-id, the
__SKILL_CONTEXT_JSON env var, or __CONVERSATION_ID env var.

Examples:
  $ assistant task save --title "Deploy workflow"
  $ assistant task save --conversation-id conv_abc123 --title "My task"
  $ assistant task save --json`,
    )
    .action(
      async (opts: {
        conversationId?: string;
        title?: string;
        json?: boolean;
      }) => {
        let conversationId: string;
        try {
          conversationId = resolveConversationId(opts.conversationId);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
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

        const params: Record<string, unknown> = {
          conversation_id: conversationId,
        };
        if (opts.title) params.title = opts.title;

        const result = await cliIpcCall("task/save", params);

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
            JSON.stringify({ ok: true, result: result.result }) + "\n",
          );
        } else {
          log.info(JSON.stringify(result.result, null, 2));
        }
      },
    );

  // ── list ──────────────────────────────────────────────────────────

  task
    .command("list")
    .description("List all saved task templates")
    .option("--json", "Output result as machine-readable JSON.")
    .addHelpText(
      "after",
      `
Lists all saved task templates with their IDs, names, and metadata.

Examples:
  $ assistant task list
  $ assistant task list --json`,
    )
    .action(async (opts: { json?: boolean }) => {
      const result = await cliIpcCall("task/list");

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
          JSON.stringify({ ok: true, result: result.result }) + "\n",
        );
      } else {
        log.info(JSON.stringify(result.result, null, 2));
      }
    });

  // ── run ───────────────────────────────────────────────────────────

  task
    .command("run")
    .description("Run a task template by ID or name")
    .option(
      "--id <id>",
      "Task template ID to run -- run 'assistant task list' to find it.",
    )
    .option(
      "--name <name>",
      "Task template name to run -- run 'assistant task list' to find it.",
    )
    .option("--inputs <json>", "JSON string of inputs for the task.")
    .option("--json", "Output result as machine-readable JSON.")
    .addHelpText(
      "after",
      `
Runs a task template, creating a new conversation for execution.
Specify the task by --id or --name. Optionally pass --inputs as a
JSON string to provide runtime parameters.

Examples:
  $ assistant task run --id task_abc123
  $ assistant task run --name "Deploy workflow"
  $ assistant task run --name "Deploy workflow" --inputs '{"env":"prod"}'
  $ assistant task run --id task_abc123 --json`,
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

        const result = await cliIpcCall("task/run", params);

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
            JSON.stringify({ ok: true, result: result.result }) + "\n",
          );
        } else {
          log.info(JSON.stringify(result.result, null, 2));
        }
      },
    );

  // ── delete ────────────────────────────────────────────────────────

  task
    .command("delete <ids...>")
    .description("Delete one or more task templates by ID")
    .option("--json", "Output result as machine-readable JSON.")
    .addHelpText(
      "after",
      `
Arguments:
  ids   One or more task template IDs to delete. Run 'assistant task list'
        to find IDs.

Removes task templates permanently. Accepts multiple IDs for batch deletion.

Examples:
  $ assistant task delete task_abc123
  $ assistant task delete task_abc123 task_def456
  $ assistant task delete task_abc123 --json`,
    )
    .action(async (ids: string[], opts: { json?: boolean }) => {
      const result = await cliIpcCall("task/delete", { task_ids: ids });

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
          JSON.stringify({ ok: true, result: result.result }) + "\n",
        );
      } else {
        log.info(JSON.stringify(result.result, null, 2));
      }
    });

  // ── queue (subcommand group) ──────────────────────────────────────

  const queue = task.command("queue").description("Manage work queue items");

  queue.addHelpText(
    "after",
    `
The work queue holds pending, in-progress, and completed work items.
Work items are derived from task templates and can be managed
independently.

Examples:
  $ assistant task queue show
  $ assistant task queue show --status pending
  $ assistant task queue add --name "Deploy workflow" --title "Deploy v2"
  $ assistant task queue update --work-item-id wi_abc123 --status completed
  $ assistant task queue remove --work-item-id wi_abc123
  $ assistant task queue run`,
  );

  // ── queue show ──────────────────────────────────────────────────

  queue
    .command("show")
    .description("Show work items in the queue")
    .option("--status <status>", "Filter by work item status.")
    .option("--json", "Output result as machine-readable JSON.")
    .addHelpText(
      "after",
      `
Displays work items in the queue, optionally filtered by status.

Examples:
  $ assistant task queue show
  $ assistant task queue show --status pending
  $ assistant task queue show --json`,
    )
    .action(async (opts: { status?: string; json?: boolean }) => {
      const params: Record<string, unknown> = {};
      if (opts.status) params.status = opts.status;

      const result = await cliIpcCall<{ content: string; isError?: boolean }>(
        "task/queue/show",
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

      if (result.result?.isError) {
        if (opts.json) {
          process.stdout.write(
            JSON.stringify({ ok: false, error: result.result.content }) + "\n",
          );
        } else {
          log.error(`Error: ${result.result.content}`);
        }
        process.exitCode = 1;
        return;
      }

      if (opts.json) {
        process.stdout.write(
          JSON.stringify({ ok: true, result: result.result }) + "\n",
        );
      } else {
        log.info(JSON.stringify(result.result, null, 2));
      }
    });

  // ── queue add ───────────────────────────────────────────────────

  queue
    .command("add")
    .description("Add a work item to the queue")
    .option("--title <title>", "Title for the work item.")
    .option(
      "--id <id>",
      "Task template ID -- run 'assistant task list' to find it.",
    )
    .option(
      "--name <name>",
      "Task template name -- run 'assistant task list' to find it.",
    )
    .option(
      "--execution-prompt <prompt>",
      "Execution prompt for the work item.",
    )
    .option("--notes <notes>", "Notes for the work item.")
    .option("--priority <tier>", "Priority tier (number).", parseInt)
    .option("--sort-index <n>", "Sort index (number).", parseInt)
    .option(
      "--if-exists <strategy>",
      "Strategy when item exists: create_duplicate, reuse_existing, update_existing.",
    )
    .option(
      "--required-tools <tools>",
      "Comma-separated list of required tool names.",
    )
    .option("--json", "Output result as machine-readable JSON.")
    .addHelpText(
      "after",
      `
Adds a new work item to the queue, optionally linked to a task template.

--required-tools accepts a comma-separated string of tool names, which is
split into an array before sending to the assistant.

--if-exists controls behavior when a matching item already exists:
  create_duplicate   Create a new item regardless (default)
  reuse_existing     Return the existing item without changes
  update_existing    Update the existing item with provided values

Examples:
  $ assistant task queue add --name "Deploy workflow" --title "Deploy v2"
  $ assistant task queue add --id task_abc123 --priority 1 --notes "Urgent"
  $ assistant task queue add --name "Build" --required-tools "bash,browser"
  $ assistant task queue add --name "Build" --if-exists update_existing --json`,
    )
    .action(
      async (opts: {
        title?: string;
        id?: string;
        name?: string;
        executionPrompt?: string;
        notes?: string;
        priority?: number;
        sortIndex?: number;
        ifExists?: string;
        requiredTools?: string;
        json?: boolean;
      }) => {
        const params: Record<string, unknown> = {};
        if (opts.title) params.title = opts.title;
        if (opts.id) params.task_id = opts.id;
        if (opts.name) params.task_name = opts.name;
        if (opts.executionPrompt)
          params.execution_prompt = opts.executionPrompt;
        if (opts.notes) params.notes = opts.notes;
        if (opts.priority !== undefined) params.priority_tier = opts.priority;
        if (opts.sortIndex !== undefined) params.sort_index = opts.sortIndex;
        if (opts.ifExists) params.if_exists = opts.ifExists;
        if (opts.requiredTools) {
          params.required_tools = opts.requiredTools
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean);
        }

        const result = await cliIpcCall<{
          content: string;
          isError?: boolean;
        }>("task/queue/add", params);

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

        if (result.result?.isError) {
          if (opts.json) {
            process.stdout.write(
              JSON.stringify({ ok: false, error: result.result.content }) +
                "\n",
            );
          } else {
            log.error(`Error: ${result.result.content}`);
          }
          process.exitCode = 1;
          return;
        }

        if (opts.json) {
          process.stdout.write(
            JSON.stringify({ ok: true, result: result.result }) + "\n",
          );
        } else {
          log.info(JSON.stringify(result.result, null, 2));
        }
      },
    );

  // ── queue update ────────────────────────────────────────────────

  queue
    .command("update")
    .description("Update work items in the queue")
    .option(
      "--work-item-id <id>",
      "Work item ID to update -- run 'assistant task queue show' to find it.",
    )
    .option(
      "--task-id <id>",
      "Task template ID filter -- run 'assistant task list' to find it.",
    )
    .option(
      "--task-name <name>",
      "Task template name filter -- run 'assistant task list' to find it.",
    )
    .option("--title <title>", "New title for the work item.")
    .option("--priority <tier>", "New priority tier (number).", parseInt)
    .option("--notes <notes>", "New notes for the work item.")
    .option("--status <status>", "New status for the work item.")
    .option("--sort-index <n>", "New sort index (number).", parseInt)
    .option(
      "--filter-priority <tier>",
      "Filter by priority tier (number).",
      parseInt,
    )
    .option("--filter-status <status>", "Filter by status.")
    .option(
      "--created-order <n>",
      "Filter by creation order (number).",
      parseInt,
    )
    .option("--json", "Output result as machine-readable JSON.")
    .addHelpText(
      "after",
      `
Updates one or more work items in the queue. Use --work-item-id to target
a specific item, or use filter options (--task-id, --task-name,
--filter-priority, --filter-status, --created-order) to match items.

Examples:
  $ assistant task queue update --work-item-id wi_abc123 --status completed
  $ assistant task queue update --task-name "Deploy" --priority 1
  $ assistant task queue update --work-item-id wi_abc123 --title "New title" --json`,
    )
    .action(
      async (opts: {
        workItemId?: string;
        taskId?: string;
        taskName?: string;
        title?: string;
        priority?: number;
        notes?: string;
        status?: string;
        sortIndex?: number;
        filterPriority?: number;
        filterStatus?: string;
        createdOrder?: number;
        json?: boolean;
      }) => {
        const params: Record<string, unknown> = {};
        if (opts.workItemId) params.work_item_id = opts.workItemId;
        if (opts.taskId) params.task_id = opts.taskId;
        if (opts.taskName) params.task_name = opts.taskName;
        if (opts.title) params.title = opts.title;
        if (opts.priority !== undefined) params.priority_tier = opts.priority;
        if (opts.notes) params.notes = opts.notes;
        if (opts.status) params.status = opts.status;
        if (opts.sortIndex !== undefined) params.sort_index = opts.sortIndex;
        if (opts.filterPriority !== undefined)
          params.filter_priority_tier = opts.filterPriority;
        if (opts.filterStatus) params.filter_status = opts.filterStatus;
        if (opts.createdOrder !== undefined)
          params.created_order = opts.createdOrder;

        const result = await cliIpcCall<{
          content: string;
          isError?: boolean;
        }>("task/queue/update", params);

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

        if (result.result?.isError) {
          if (opts.json) {
            process.stdout.write(
              JSON.stringify({ ok: false, error: result.result.content }) +
                "\n",
            );
          } else {
            log.error(`Error: ${result.result.content}`);
          }
          process.exitCode = 1;
          return;
        }

        if (opts.json) {
          process.stdout.write(
            JSON.stringify({ ok: true, result: result.result }) + "\n",
          );
        } else {
          log.info(JSON.stringify(result.result, null, 2));
        }
      },
    );

  // ── queue remove ────────────────────────────────────────────────

  queue
    .command("remove")
    .description("Remove work items from the queue")
    .option(
      "--work-item-id <id>",
      "Work item ID to remove -- run 'assistant task queue show' to find it.",
    )
    .option(
      "--task-id <id>",
      "Task template ID filter -- run 'assistant task list' to find it.",
    )
    .option(
      "--task-name <name>",
      "Task template name filter -- run 'assistant task list' to find it.",
    )
    .option("--title <title>", "Title filter.")
    .option("--priority <tier>", "Priority tier filter (number).", parseInt)
    .option("--status <status>", "Status filter.")
    .option("--created-order <n>", "Creation order filter (number).", parseInt)
    .option("--json", "Output result as machine-readable JSON.")
    .addHelpText(
      "after",
      `
Removes one or more work items from the queue. Use --work-item-id to
target a specific item, or use filter options to match multiple items.

Examples:
  $ assistant task queue remove --work-item-id wi_abc123
  $ assistant task queue remove --task-name "Deploy" --status completed
  $ assistant task queue remove --work-item-id wi_abc123 --json`,
    )
    .action(
      async (opts: {
        workItemId?: string;
        taskId?: string;
        taskName?: string;
        title?: string;
        priority?: number;
        status?: string;
        createdOrder?: number;
        json?: boolean;
      }) => {
        const params: Record<string, unknown> = {};
        if (opts.workItemId) params.work_item_id = opts.workItemId;
        if (opts.taskId) params.task_id = opts.taskId;
        if (opts.taskName) params.task_name = opts.taskName;
        if (opts.title) params.title = opts.title;
        if (opts.priority !== undefined) params.priority_tier = opts.priority;
        if (opts.status) params.status = opts.status;
        if (opts.createdOrder !== undefined)
          params.created_order = opts.createdOrder;

        const result = await cliIpcCall<{
          content: string;
          isError?: boolean;
        }>("task/queue/remove", params);

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

        if (result.result?.isError) {
          if (opts.json) {
            process.stdout.write(
              JSON.stringify({ ok: false, error: result.result.content }) +
                "\n",
            );
          } else {
            log.error(`Error: ${result.result.content}`);
          }
          process.exitCode = 1;
          return;
        }

        if (opts.json) {
          process.stdout.write(
            JSON.stringify({ ok: true, result: result.result }) + "\n",
          );
        } else {
          log.info(JSON.stringify(result.result, null, 2));
        }
      },
    );

  // ── queue run ───────────────────────────────────────────────────

  queue
    .command("run")
    .description("Run the next work item from the queue")
    .option(
      "--work-item-id <id>",
      "Specific work item ID to run -- run 'assistant task queue show' to find it.",
    )
    .option(
      "--task-name <name>",
      "Task template name filter -- run 'assistant task list' to find it.",
    )
    .option("--title <title>", "Title filter.")
    .option("--json", "Output result as machine-readable JSON.")
    .addHelpText(
      "after",
      `
Runs a work item from the queue. If --work-item-id is specified, runs
that specific item. Otherwise, selects the next eligible item based on
priority and sort order, optionally filtered by --task-name or --title.

Examples:
  $ assistant task queue run
  $ assistant task queue run --work-item-id wi_abc123
  $ assistant task queue run --task-name "Deploy workflow"
  $ assistant task queue run --json`,
    )
    .action(
      async (opts: {
        workItemId?: string;
        taskName?: string;
        title?: string;
        json?: boolean;
      }) => {
        const params: Record<string, unknown> = {};
        if (opts.workItemId) params.work_item_id = opts.workItemId;
        if (opts.taskName) params.task_name = opts.taskName;
        if (opts.title) params.title = opts.title;

        const result = await cliIpcCall<{
          content: string;
          isError?: boolean;
        }>("task/queue/run", params);

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

        if (result.result?.isError) {
          if (opts.json) {
            process.stdout.write(
              JSON.stringify({ ok: false, error: result.result.content }) +
                "\n",
            );
          } else {
            log.error(`Error: ${result.result.content}`);
          }
          process.exitCode = 1;
          return;
        }

        if (opts.json) {
          process.stdout.write(
            JSON.stringify({ ok: true, result: result.result }) + "\n",
          );
        } else {
          log.info(JSON.stringify(result.result, null, 2));
        }
      },
    );
}
