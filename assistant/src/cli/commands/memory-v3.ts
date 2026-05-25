/**
 * `assistant memory v3` CLI subgroup.
 *
 * Operator-facing read-only inspection of the v3 memory tree — the DAG overlay
 * the v2 → v3 data-migration hand-authors over the flat concept pages.
 *
 * Subcommands:
 *
 *   - `validate` — print a structural health report (dangling refs, orphan
 *     pages, cycles, stale indexes, unknown edge targets). Exits non-zero when
 *     any defect is found so it is scriptable as a check.
 *   - `tree` — print the tree as an indented outline rooted at the tree root,
 *     marking shared-DAG re-entries.
 *
 * Both are read-only: they mutate nothing and run no LLM. `--json` emits the
 * raw daemon payload for either subcommand.
 */

import type { Command } from "commander";

import { cliIpcCall } from "../../ipc/cli-client.js";
import type {
  MemoryV3TreeResult,
  MemoryV3ValidateResult,
} from "../../runtime/routes/memory-v3-routes.js";
import { registerCommand } from "../lib/register-command.js";
import { log } from "../logger.js";
import {
  renderTree,
  renderValidationReport,
  reportHasDefects,
} from "./memory-v3-render.js";

export function registerMemoryV3Command(program: Command): void {
  // Reuse an existing `memory` parent if a sibling registrar (e.g. v2)
  // attached it first; otherwise create one. Keeps registration order between
  // sibling memory registrars unconstrained.
  const memory =
    program.commands.find((c) => c.name() === "memory") ??
    program
      .command("memory")
      .description("Manage the memory subsystem (concept-page model)");

  registerCommand(memory, {
    name: "v3",
    transport: "ipc",
    description: "Memory v3 subsystem operations (tree-DAG overlay)",
    build: (v3) => {
      v3.addHelpText(
        "after",
        `
The v3 memory subsystem layers a hand-authored DAG of tree nodes over the
flat v2 concept pages. Each node lives under /workspace/memory/v3/tree/ and
its frontmatter 'children' list references sub-nodes (node:<id>) and leaf
concept pages (page:<slug>). The structure is authored by the v2 → v3
data-migration, so these subcommands are read-only inspection only — they
mutate nothing and run no LLM.

Examples:
  $ assistant memory v3 validate
  $ assistant memory v3 tree
  $ assistant memory v3 tree --json | jq '.nodes | length'`,
      );

      // ── validate ──────────────────────────────────────────────────────────

      v3.command("validate")
        .description(
          "Print a structural health report of the v3 tree (read-only)",
        )
        .option("--json", "Emit raw JSON instead of a formatted report")
        .addHelpText(
          "after",
          `
Walks the hand-authored v3 tree DAG and reports:
  - Dangling child refs (node:/page: targets that do not exist)
  - Orphan pages (concept pages not reachable from the tree root)
  - Cycles (back-edges in the node:/node: adjacency)
  - Stale indexes (a node older than a child it composes)
  - Unknown edge targets (page edges: pointing at a missing slug)

Read-only — mutates nothing. Exits non-zero if any defect is reported, so it
is usable as a pre-flight check while the v2 → v3 migration is in flight.

Examples:
  $ assistant memory v3 validate
  $ assistant memory v3 validate --json | jq '.orphanPageCount'`,
        )
        .action(async (opts: { json?: boolean }) => {
          const result = await cliIpcCall<MemoryV3ValidateResult>(
            "memory_v3_validate",
            { body: {} },
          );

          if (!result.ok) {
            log.error(result.error ?? "Failed to validate memory v3 tree");
            process.exitCode = 1;
            return;
          }

          const report = result.result!;

          if (opts.json === true) {
            log.info(JSON.stringify(report, null, 2));
          } else {
            log.info(renderValidationReport(report));
          }

          if (reportHasDefects(report)) {
            process.exitCode = 1;
          }
        });

      // ── tree ──────────────────────────────────────────────────────────────

      v3.command("tree")
        .description(
          "Print the v3 tree as an indented outline from the root (read-only)",
        )
        .option("--json", "Emit raw JSON instead of a formatted tree")
        .addHelpText(
          "after",
          `
Descends the v3 tree depth-first from its root node, printing one line per
node:/page: ref with indentation by depth. A node reached more than once
(shared DAG sub-node or a cycle back-edge) is printed once with a re-entry
marker rather than re-expanded, so output is finite. Nodes that exist on disk
but are unreachable from the root are listed separately.

Read-only — mutates nothing.

Examples:
  $ assistant memory v3 tree
  $ assistant memory v3 tree --json | jq '.root'`,
        )
        .action(async (opts: { json?: boolean }) => {
          const result = await cliIpcCall<MemoryV3TreeResult>(
            "memory_v3_tree",
            {
              body: {},
            },
          );

          if (!result.ok) {
            log.error(result.error ?? "Failed to read memory v3 tree");
            process.exitCode = 1;
            return;
          }

          const view = result.result!;

          if (opts.json === true) {
            log.info(JSON.stringify(view, null, 2));
            return;
          }

          log.info(renderTree(view));
        });
    },
  });
}
