/**
 * `assistant memory items` CLI subgroup.
 *
 * Full CRUD over individual memory items (graph nodes), each subcommand a
 * thin IPC wrapper over the daemon's memory-item routes:
 *
 *   - `list`   → listMemoryItems
 *   - `get`    → getMemoryItem
 *   - `create` → createMemoryItem
 *   - `update` → updateMemoryItem
 *   - `delete` → deleteMemoryItem
 */

import type { Command } from "commander";

import { cliIpcCall, exitFromIpcResult } from "../../../ipc/cli-client.js";
import { confirmPrompt } from "../../lib/confirm-prompt.js";
import { registerCommand } from "../../lib/register-command.js";
import { log } from "../../logger.js";
import { writeOutput } from "../../output.js";

/**
 * Memory kinds accepted by the daemon's memory-item routes. Mirrored here
 * for help text only — the route validates and rejects unknown kinds.
 */
const MEMORY_KINDS =
  "episodic, semantic, procedural, emotional, prospective, behavioral, narrative, shared";

interface MemoryItemPayload {
  id: string;
  kind: string;
  subject: string;
  statement: string;
  status: string;
  confidence: number;
  importance: number;
  firstSeenAt: number;
  lastSeenAt: number;
}

interface ListMemoryItemsResponse {
  items: MemoryItemPayload[];
  total: number;
  kindCounts: Record<string, number>;
}

interface MemoryItemResponse {
  item: MemoryItemPayload;
}

function parseImportance(raw: string): number | null {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    log.error(
      `Invalid --importance "${raw}". Must be a number between 0 and 1.`,
    );
    process.exitCode = 1;
    return null;
  }
  return parsed;
}

function requireId(
  id: string,
  opts: { json?: boolean },
  cmd: Command,
): string | null {
  const trimmed = id.trim();
  if (!trimmed) {
    const error =
      "Memory item ID is required. Run 'assistant memory items list' to find it.";
    if (opts.json) {
      writeOutput(cmd, { ok: false, error });
    } else {
      log.error(error);
    }
    process.exitCode = 1;
    return null;
  }
  return trimmed;
}

export function registerMemoryItemsCommand(memory: Command): void {
  registerCommand(memory, {
    name: "items",
    transport: "ipc",
    description: "Manage individual memory items (full CRUD)",
    build: (items) => {
      items.addHelpText(
        "after",
        `
Memory items are individual remembered facts (graph nodes) with a kind
(${MEMORY_KINDS}),
a subject line, and a statement. Items are normally created by the
assistant via the remember tool; 'items create' exists for manual seeding
and repair.

Examples:
  $ assistant memory items list --search "coffee"
  $ assistant memory items update 9f2c4f3a-3f1a-41e4-88e7-abc123 --statement "Prefers tea"
  $ assistant memory items delete 9f2c4f3a-3f1a-41e4-88e7-abc123`,
      );

      // ── list ──────────────────────────────────────────────────────────────

      items
        .command("list")
        .alias("ls")
        .description("List memory items with filtering, search, and pagination")
        .option("--kind <kind>", `Filter by kind (${MEMORY_KINDS})`)
        .option(
          "--status <status>",
          "Filter by status: active (default), inactive, or all",
        )
        .option("--search <query>", "Semantic/full-text search query")
        .option(
          "--sort <field>",
          "Sort field: lastSeenAt (default), importance, kind, or firstSeenAt",
        )
        .option("--order <order>", "asc or desc (default desc)")
        .option("--limit <n>", "Max results (default 100)")
        .option("--offset <n>", "Pagination offset (default 0)")
        .option("--json", "Machine-readable compact JSON output")
        .addHelpText(
          "after",
          `
Behavior:
  Lists memory items (remembered facts) from the assistant's memory store.
  With --search, results are ranked by semantic relevance when the embedding
  backend is available, falling back to substring match otherwise. Deleted
  items are hidden unless --status inactive or --status all is passed.

Examples:
  $ assistant memory items list
  $ assistant memory items list --kind semantic --limit 20
  $ assistant memory items list --search "favorite restaurants" --json`,
        )
        .action(
          async (
            opts: {
              kind?: string;
              status?: string;
              search?: string;
              sort?: string;
              order?: string;
              limit?: string;
              offset?: string;
              json?: boolean;
            },
            cmd: Command,
          ) => {
            const queryParams: Record<string, string> = {};
            if (opts.kind) {
              queryParams.kind = opts.kind;
            }
            if (opts.status) {
              queryParams.status = opts.status;
            }
            if (opts.search) {
              queryParams.search = opts.search;
            }
            if (opts.sort) {
              queryParams.sort = opts.sort;
            }
            if (opts.order) {
              queryParams.order = opts.order;
            }
            if (opts.limit) {
              queryParams.limit = opts.limit;
            }
            if (opts.offset) {
              queryParams.offset = opts.offset;
            }

            const result = await cliIpcCall<ListMemoryItemsResponse>(
              "listMemoryItems",
              { queryParams },
            );

            if (!result.ok) {
              return exitFromIpcResult(result, cmd);
            }

            const response = result.result ?? {
              items: [],
              total: 0,
              kindCounts: {},
            };

            if (opts.json) {
              writeOutput(cmd, response);
              return;
            }

            if (response.items.length === 0) {
              log.info("No memory items found.");
              return;
            }

            const kindWidth = Math.max(
              4,
              ...response.items.map((item) => item.kind.length),
            );
            console.log(
              `${"ID".padEnd(36)}  ${"KIND".padEnd(kindWidth)}  ${"IMP".padEnd(4)}  SUBJECT`,
            );
            for (const item of response.items) {
              console.log(
                `${item.id.padEnd(36)}  ${item.kind.padEnd(kindWidth)}  ${item.importance.toFixed(2)}  ${item.subject}`,
              );
            }
            console.log(
              `\n${response.items.length} of ${response.total} memory item(s)`,
            );
          },
        );

      // ── get ───────────────────────────────────────────────────────────────

      items
        .command("get <id>")
        .description("Get a single memory item by ID")
        .option("--json", "Machine-readable compact JSON output")
        .addHelpText(
          "after",
          `
Arguments:
  <id>   Memory item ID (UUID) — run 'assistant memory items list' to find it.

Examples:
  $ assistant memory items get 9f2c4f3a-3f1a-41e4-88e7-abc123
  $ assistant memory items get 9f2c4f3a-3f1a-41e4-88e7-abc123 --json`,
        )
        .action(async (id: string, opts: { json?: boolean }, cmd: Command) => {
          const itemId = requireId(id, opts, cmd);
          if (!itemId) {
            return;
          }

          const result = await cliIpcCall<MemoryItemResponse>("getMemoryItem", {
            pathParams: { id: itemId },
          });

          if (!result.ok) {
            return exitFromIpcResult(result, cmd);
          }

          writeOutput(cmd, result.result);
        });

      // ── create ────────────────────────────────────────────────────────────

      items
        .command("create")
        .description("Create a new memory item")
        .requiredOption("--kind <kind>", `Memory kind (${MEMORY_KINDS})`)
        .requiredOption("--statement <text>", "Statement content of the memory")
        .option("--subject <text>", "Subject line (defaults to the statement)")
        .option("--importance <n>", "Importance score 0-1 (default 0.8)")
        .option("--json", "Machine-readable compact JSON output")
        .addHelpText(
          "after",
          `
Behavior:
  Creates a memory graph node and enqueues its embedding so it becomes
  recallable. Fails with a conflict error if an active item with identical
  content already exists. Memories are normally formed by the assistant via
  the remember tool — use this for manual seeding and repair.

Examples:
  $ assistant memory items create --kind semantic --statement "User prefers dark mode"
  $ assistant memory items create --kind procedural --subject "Deploys" \\
      --statement "Deploys go out Tuesdays after standup" --importance 0.9`,
        )
        .action(
          async (
            opts: {
              kind: string;
              statement: string;
              subject?: string;
              importance?: string;
              json?: boolean;
            },
            cmd: Command,
          ) => {
            const body: Record<string, unknown> = {
              kind: opts.kind,
              statement: opts.statement,
            };
            if (opts.subject !== undefined) {
              body.subject = opts.subject;
            }
            if (opts.importance !== undefined) {
              const parsed = parseImportance(opts.importance);
              if (parsed == null) {
                return;
              }
              body.importance = parsed;
            }

            const result = await cliIpcCall<MemoryItemResponse>(
              "createMemoryItem",
              { body },
            );

            if (!result.ok) {
              return exitFromIpcResult(result, cmd);
            }

            if (opts.json) {
              writeOutput(cmd, result.result);
              return;
            }

            log.info(`Created memory item: ${result.result?.item.id}`);
          },
        );

      // ── update ────────────────────────────────────────────────────────────

      items
        .command("update <id>")
        .description("Update fields on an existing memory item")
        .option("--subject <text>", "Replace the subject line")
        .option("--statement <text>", "Replace the statement content")
        .option("--kind <kind>", `Change the kind (${MEMORY_KINDS})`)
        .option(
          "--status <status>",
          "Set status: active (restores a deleted item) or superseded",
        )
        .option("--importance <n>", "Set importance score 0-1")
        .option("--json", "Machine-readable compact JSON output")
        .addHelpText(
          "after",
          `
Arguments:
  <id>   Memory item ID (UUID) — run 'assistant memory items list' to find it.

Behavior:
  Partially updates the given fields; anything not passed is left unchanged.
  Content changes trigger re-embedding so recall stays consistent. Setting
  --status active restores a previously deleted item; --status superseded
  retires it (same effect as 'assistant memory items delete'). Fails with a
  conflict error when the new content duplicates another active item.

Examples:
  $ assistant memory items update 9f2c4f3a-3f1a-41e4-88e7-abc123 --statement "Prefers tea over coffee"
  $ assistant memory items update 9f2c4f3a-3f1a-41e4-88e7-abc123 --importance 0.9 --kind semantic
  $ assistant memory items update 9f2c4f3a-3f1a-41e4-88e7-abc123 --status active`,
        )
        .action(
          async (
            id: string,
            opts: {
              subject?: string;
              statement?: string;
              kind?: string;
              status?: string;
              importance?: string;
              json?: boolean;
            },
            cmd: Command,
          ) => {
            const itemId = requireId(id, opts, cmd);
            if (!itemId) {
              return;
            }

            const body: Record<string, unknown> = {};
            if (opts.subject !== undefined) {
              body.subject = opts.subject;
            }
            if (opts.statement !== undefined) {
              body.statement = opts.statement;
            }
            if (opts.kind !== undefined) {
              body.kind = opts.kind;
            }
            if (opts.status !== undefined) {
              body.status = opts.status;
            }
            if (opts.importance !== undefined) {
              const parsed = parseImportance(opts.importance);
              if (parsed == null) {
                return;
              }
              body.importance = parsed;
            }

            if (Object.keys(body).length === 0) {
              log.error(
                "At least one update flag is required. Run 'assistant memory items update --help' for the available flags.",
              );
              process.exitCode = 1;
              return;
            }

            const result = await cliIpcCall<MemoryItemResponse>(
              "updateMemoryItem",
              { pathParams: { id: itemId }, body },
            );

            if (!result.ok) {
              return exitFromIpcResult(result, cmd);
            }

            if (opts.json) {
              writeOutput(cmd, result.result);
              return;
            }

            log.info(`Updated memory item: ${itemId}`);
          },
        );

      // ── delete ────────────────────────────────────────────────────────────

      items
        .command("delete <id>")
        .alias("rm")
        .description("Delete a memory item")
        .option("--force", "Skip the confirmation prompt")
        .option("--json", "Machine-readable compact JSON output")
        .addHelpText(
          "after",
          `
Options:
  --force  Skip the destructive y/N confirmation prompt. Required when stdin
           is not a TTY (e.g. in scripts and CI).
  --json   Output the deletion result as compact JSON.

Arguments:
  <id>   Memory item ID (UUID) — run 'assistant memory items list' to find it.

Behavior:
  Soft-deletes the memory item — it stops being recalled and its embeddings
  are removed from the index, but the underlying record is retained. A
  deleted item can be restored with
  'assistant memory items update <id> --status active'.

Examples:
  $ assistant memory items delete 9f2c4f3a-3f1a-41e4-88e7-abc123
  $ assistant memory items delete 9f2c4f3a-3f1a-41e4-88e7-abc123 --force --json`,
        )
        .action(
          async (
            id: string,
            opts: { force?: boolean; json?: boolean },
            cmd: Command,
          ) => {
            const itemId = requireId(id, opts, cmd);
            if (!itemId) {
              return;
            }

            if (!opts.force) {
              const decision = await confirmPrompt({
                question: `Delete memory item "${itemId}"? [y/N] `,
                isTTY: Boolean(process.stdin.isTTY),
                refuseNonInteractiveMessage: `Refusing to delete memory item "${itemId}" non-interactively. Pass --force to confirm.`,
              });
              if (decision === "non-interactive") {
                process.exitCode = 1;
                return;
              }
              if (decision === "denied") {
                log.info("Delete cancelled.");
                return;
              }
            }

            const result = await cliIpcCall<null>("deleteMemoryItem", {
              pathParams: { id: itemId },
            });

            if (!result.ok) {
              return exitFromIpcResult(result, cmd);
            }

            if (opts.json) {
              writeOutput(cmd, { deleted: true, id: itemId });
              return;
            }

            log.info(`Deleted memory item: ${itemId}`);
          },
        );
    },
  });
}
