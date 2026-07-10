/**
 * `assistant memory nodes` CLI subgroup.
 *
 * Content-based CRUD over the memory v2 graph nodes, routed through the
 * daemon's memory-nodes routes via IPC:
 *
 *   - `list`   → `listMemoryNodes`
 *   - `delete` → `deleteMemoryNode`
 *   - `update` → `updateMemoryNode`
 *
 * Unlike `memory items`, which addresses nodes by UUID, these commands address
 * nodes by content text — matching the way an operator or agent naturally
 * refers to a remembered fact without first running a list.
 */

import type { Command } from "commander";

import { cliIpcCall } from "../../../ipc/cli-client.js";
import { registerCommand } from "../../lib/register-command.js";
import { log } from "../../logger.js";
import { writeOutput } from "../../output.js";

/** Wire shapes of the daemon's memory-nodes route responses. */
interface MemoryNodeEntry {
  id: string;
  content: string;
  type: string;
  fidelity: string;
  created: number;
}

interface ListMemoryNodesResult {
  success: boolean;
  message: string;
  nodes: MemoryNodeEntry[];
  total: number;
}

interface MemoryNodeMutationResult {
  success: boolean;
  message: string;
}

export function registerMemoryNodesCommand(memory: Command): void {
  registerCommand(memory, {
    name: "nodes",
    transport: "ipc",
    description: "Content-based list, delete, and update of memory graph nodes",
    build: (nodes) => {
      nodes.addHelpText(
        "after",
        `
Memory nodes are raw graph records (content, type, fidelity) produced by the
memory v2 subsystem. Unlike 'memory items', which addresses nodes by UUID, these
commands address nodes by content text — matching the way an operator refers to
a remembered fact without first looking up its ID.

All subcommands require memory v2 to be enabled and the assistant to be running.

Examples:
  $ assistant memory nodes list
  $ assistant memory nodes list --search "TypeScript" --limit 20
  $ assistant memory nodes delete "User prefers TypeScript"
  $ assistant memory nodes update "User prefers TypeScript" "User prefers TypeScript and Bun"`,
      );

      // ── list ──────────────────────────────────────────────────────────────

      nodes
        .command("list")
        .alias("ls")
        .description("List active memory graph nodes")
        .option(
          "--search <query>",
          "Filter nodes whose content contains <query>",
        )
        .option("--limit <n>", "Max results (default 50, max 200)")
        .option("--json", "Machine-readable compact JSON output")
        .addHelpText(
          "after",
          `
Behavior:
  Returns active (non-deleted) memory graph nodes ordered by significance.
  With --search, all nodes are scanned so the filter is exhaustive regardless
  of graph size. Without --search the query is capped at --limit rows at the
  DB level for efficiency.

Examples:
  $ assistant memory nodes list
  $ assistant memory nodes list --search "coffee" --limit 10
  $ assistant memory nodes list --json`,
        )
        .action(
          async (
            opts: { search?: string; limit?: string; json?: boolean },
            cmd: Command,
          ) => {
            const queryParams: Record<string, string> = {};
            if (opts.search) {
              queryParams.search = opts.search;
            }
            if (opts.limit) {
              queryParams.limit = opts.limit;
            }
            const r = await cliIpcCall<ListMemoryNodesResult>(
              "listMemoryNodes",
              { queryParams },
            );
            if (!r.ok) {
              log.error(r.error ?? "Failed to list memory nodes");
              process.exitCode = 1;
              return;
            }
            const result = r.result!;

            if (!result.success) {
              log.error(result.message);
              process.exitCode = 1;
              return;
            }

            if (opts.json) {
              writeOutput(cmd, { nodes: result.nodes, total: result.total });
              return;
            }

            if (result.nodes.length === 0) {
              log.info(
                opts.search
                  ? `No memory nodes found matching "${opts.search}".`
                  : "No memory nodes found. The memory graph is empty.",
              );
              return;
            }

            const CONTENT_WIDTH = 60;
            const truncate = (s: string) =>
              s.length > CONTENT_WIDTH
                ? s.slice(0, CONTENT_WIDTH - 1) + "…"
                : s;

            const typeWidth = Math.max(
              4,
              ...result.nodes.map((n) => n.type.length),
            );
            const fidelityWidth = Math.max(
              7,
              ...result.nodes.map((n) => n.fidelity.length),
            );

            console.log(
              `${"CONTENT".padEnd(CONTENT_WIDTH)}  ${"TYPE".padEnd(
                typeWidth,
              )}  ${"FIDELITY".padEnd(fidelityWidth)}  CREATED`,
            );

            for (const n of result.nodes) {
              const created = new Date(n.created).toLocaleString("en-US", {
                month: "short",
                day: "numeric",
                hour: "numeric",
                minute: "2-digit",
              });
              console.log(
                `${truncate(n.content).padEnd(CONTENT_WIDTH)}  ${n.type.padEnd(
                  typeWidth,
                )}  ${n.fidelity.padEnd(fidelityWidth)}  ${created}`,
              );
            }

            console.log(
              `\n${result.total} node${result.total === 1 ? "" : "s"}${
                opts.search ? ` matching "${opts.search}"` : ""
              }`,
            );
          },
        );

      // ── delete ────────────────────────────────────────────────────────────

      nodes
        .command("delete <content>")
        .alias("rm")
        .description("Delete a memory node by content match")
        .option("--json", "Machine-readable compact JSON output")
        .addHelpText(
          "after",
          `
Arguments:
  <content>  The text of the memory to delete. Exact match (case-insensitive)
             takes priority; if no exact match exists, a substring match is
             tried. Fails when 0 or more than 1 nodes match — use
             'assistant memory nodes list --search <query>' to find exact text.

Behavior:
  Hard-deletes the graph node and removes it from the recall index. This
  operation is permanent; use 'assistant memory nodes update' to correct
  content instead of deleting it.

Examples:
  $ assistant memory nodes delete "User prefers TypeScript"
  $ assistant memory nodes delete "User prefers TypeScript" --json`,
        )
        .action(
          async (content: string, opts: { json?: boolean }, cmd: Command) => {
            if (!content.trim()) {
              log.error(
                "content is required. Run 'assistant memory nodes list' to find the exact text.",
              );
              process.exitCode = 1;
              return;
            }

            const r = await cliIpcCall<MemoryNodeMutationResult>(
              "deleteMemoryNode",
              { body: { content } },
            );
            if (!r.ok) {
              log.error(r.error ?? "Failed to delete the memory node");
              process.exitCode = 1;
              return;
            }
            const result = r.result!;

            if (!result.success) {
              log.error(result.message);
              process.exitCode = 1;
              return;
            }

            if (opts.json) {
              writeOutput(cmd, result);
              return;
            }

            log.info(result.message);
          },
        );

      // ── update ────────────────────────────────────────────────────────────

      nodes
        .command("update <old-content> <new-content>")
        .description("Update a memory node's content in place")
        .option("--json", "Machine-readable compact JSON output")
        .addHelpText(
          "after",
          `
Arguments:
  <old-content>  Text of the memory to update. Exact match (case-insensitive)
                 takes priority over substring match. Fails when 0 or more than
                 1 nodes match.
  <new-content>  Replacement text. Fails if another active node already has
                 this content (prevents duplicates).

Behavior:
  Replaces the node's content and re-embeds it so recall stays consistent.
  Use this to correct a fact rather than deleting and re-adding it — the edit
  history is preserved on the node.

Examples:
  $ assistant memory nodes update "User prefers TypeScript" "User prefers TypeScript and Bun"
  $ assistant memory nodes update "old fact" "corrected fact" --json`,
        )
        .action(
          async (
            oldContent: string,
            newContent: string,
            opts: { json?: boolean },
            cmd: Command,
          ) => {
            if (!oldContent.trim() || !newContent.trim()) {
              log.error(
                "Both <old-content> and <new-content> are required. Run 'assistant memory nodes list' to find the exact text.",
              );
              process.exitCode = 1;
              return;
            }

            const r = await cliIpcCall<MemoryNodeMutationResult>(
              "updateMemoryNode",
              { body: { oldContent, newContent } },
            );
            if (!r.ok) {
              log.error(r.error ?? "Failed to update the memory node");
              process.exitCode = 1;
              return;
            }
            const result = r.result!;

            if (!result.success) {
              log.error(result.message);
              process.exitCode = 1;
              return;
            }

            if (opts.json) {
              writeOutput(cmd, result);
              return;
            }

            log.info(result.message);
          },
        );
    },
  });
}
