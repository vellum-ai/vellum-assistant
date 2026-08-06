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
import { subcommand } from "../../lib/cli-command-help.js";
import { confirmPrompt } from "../../lib/confirm-prompt.js";
import { log } from "../../logger.js";
import { writeOutput } from "../../output.js";

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
  const items = subcommand(memory, "items");

  // ── list ──────────────────────────────────────────────────────────────

  subcommand(items, "list")
    .alias("ls")
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

  subcommand(items, "get").action(
    async (id: string, opts: { json?: boolean }, cmd: Command) => {
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
    },
  );

  // ── create ────────────────────────────────────────────────────────────

  subcommand(items, "create").action(
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

      const result = await cliIpcCall<MemoryItemResponse>("createMemoryItem", {
        body,
      });

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

  subcommand(items, "update").action(
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

      const result = await cliIpcCall<MemoryItemResponse>("updateMemoryItem", {
        pathParams: { id: itemId },
        body,
      });

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

  subcommand(items, "delete")
    .alias("rm")
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
}
