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

  // ── stats ─────────────────────────────────────────────────────────────

  subcommand(nodes, "stats").action(
    async (opts: { json?: boolean }, cmd: Command) => {
      // Deferred: loads config and the graph stats handler in-process.
      // No daemon needed — reads directly from the workspace SQLite DB.
      const [{ handleStatsMemory }, { getConfig }] = await Promise.all([
        import("../../../plugins/defaults/memory/graph/tool-handlers.js") as Promise<
          typeof import("../../../plugins/defaults/memory/graph/tool-handlers.js")
        >,
        import("../../../config/loader.js") as Promise<
          typeof import("../../../config/loader.js")
        >,
      ]);

      const result = handleStatsMemory(getConfig());

      if (!result.success) {
        log.error(result.message);
        process.exitCode = 1;
        return;
      }

      if (opts.json) {
        writeOutput(cmd, result.stats);
        return;
      }

      printStats(result.stats!);
    },
  );
}

const MEMORY_TYPES = [
  "episodic",
  "semantic",
  "procedural",
  "emotional",
  "prospective",
  "behavioral",
  "narrative",
  "shared",
] as const;

interface StatsData {
  total: number;
  byType: { [key: string]: number | undefined };
  byFidelity: { vivid: number; clear: number; faded: number; gist: number };
  atRisk: number;
  edgeCount: number;
  oldestCreated: number | null;
  newestCreated: number | null;
  lastReinforced: number | null;
  avgSignificance: number;
  topNodes: ReadonlyArray<{ content: string; significance: number }>;
}

function printStats(s: StatsData): void {
  const n = s.total;
  const e = s.edgeCount;

  console.log(
    `\nMemory graph  ${n} node${n === 1 ? "" : "s"} · ${e} edge${e === 1 ? "" : "s"}\n`,
  );

  if (n === 0) {
    console.log("  The memory graph is empty.");
    console.log("");
    return;
  }

  // ── by type ─────────────────────────────────────────────────────────────

  console.log("BY TYPE");
  for (const t of MEMORY_TYPES) {
    const count = s.byType[t] ?? 0;
    if (count > 0) {
      console.log(`  ${t.padEnd(12)}  ${count}`);
    }
  }

  // ── by fidelity (with ASCII bar) ─────────────────────────────────────────

  console.log("\nBY FIDELITY");
  const fidelities = ["vivid", "clear", "faded", "gist"] as const;
  for (const f of fidelities) {
    const count = s.byFidelity[f];
    const barLen = n > 0 ? Math.round((count / n) * 20) : 0;
    const bar = "█".repeat(barLen);
    console.log(`  ${f.padEnd(6)}  ${String(count).padStart(4)}  ${bar}`);
  }

  // ── significance ─────────────────────────────────────────────────────────

  console.log("\nSIGNIFICANCE");
  console.log(`  average    ${(s.avgSignificance * 100).toFixed(1)}%`);
  if (s.atRisk > 0) {
    console.log(
      `  at risk    ${s.atRisk} node${s.atRisk === 1 ? "" : "s"} fading (significance < 15%)`,
    );
  }

  // ── timeline ─────────────────────────────────────────────────────────────

  console.log("\nTIMELINE");
  const dateOpts: Intl.DateTimeFormatOptions = {
    month: "short",
    day: "numeric",
    year: "numeric",
  };
  if (s.oldestCreated) {
    console.log(
      `  oldest      ${new Date(s.oldestCreated).toLocaleString("en-US", dateOpts)}`,
    );
  }
  if (s.newestCreated) {
    console.log(
      `  newest      ${new Date(s.newestCreated).toLocaleString("en-US", dateOpts)}`,
    );
  }
  if (s.lastReinforced) {
    console.log(
      `  reinforced  ${new Date(s.lastReinforced).toLocaleString("en-US", {
        ...dateOpts,
        hour: "numeric",
        minute: "2-digit",
      })}`,
    );
  }

  // ── top nodes ────────────────────────────────────────────────────────────

  if (s.topNodes.length > 0) {
    console.log("\nTOP NODES BY SIGNIFICANCE");
    const WIDTH = 60;
    const trunc = (str: string) =>
      str.length > WIDTH ? str.slice(0, WIDTH - 1) + "…" : str;
    for (const node of s.topNodes) {
      console.log(
        `  ${(node.significance * 100).toFixed(0).padStart(3)}%  ${trunc(node.content)}`,
      );
    }
  }

  console.log("");
}
