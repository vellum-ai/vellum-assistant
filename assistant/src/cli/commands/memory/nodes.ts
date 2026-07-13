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

import { cliIpcCall, exitFromIpcResult } from "../../../ipc/cli-client.js";
import { subcommand } from "../../lib/cli-command-help.js";
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
  const nodes = subcommand(memory, "nodes");

  // ── list ──────────────────────────────────────────────────────────────

  subcommand(nodes, "list")
    .alias("ls")
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
        const r = await cliIpcCall<ListMemoryNodesResult>("listMemoryNodes", {
          queryParams,
        });
        if (!r.ok) {
          exitFromIpcResult(r, cmd);
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
          s.length > CONTENT_WIDTH ? s.slice(0, CONTENT_WIDTH - 1) + "…" : s;

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

  subcommand(nodes, "delete")
    .alias("rm")
    .action(async (content: string, opts: { json?: boolean }, cmd: Command) => {
      if (!content.trim()) {
        log.error(
          "content is required. Run 'assistant memory nodes list' to find the exact text.",
        );
        process.exitCode = 1;
        return;
      }

      const r = await cliIpcCall<MemoryNodeMutationResult>("deleteMemoryNode", {
        body: { content },
      });
      if (!r.ok) {
        exitFromIpcResult(r, cmd);
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
    });

  // ── update ────────────────────────────────────────────────────────────

  subcommand(nodes, "update").action(
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

      const r = await cliIpcCall<MemoryNodeMutationResult>("updateMemoryNode", {
        body: { oldContent, newContent },
      });
      if (!r.ok) {
        exitFromIpcResult(r, cmd);
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
}
