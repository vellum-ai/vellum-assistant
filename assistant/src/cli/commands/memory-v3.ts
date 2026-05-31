/**
 * `assistant memory v3` CLI subgroup.
 *
 * Operator-facing tree-gardening + core-editing subcommands for the v3 memory
 * subsystem (leaf-tree activation model). The daemon owns the live tree, so the
 * mutating verbs route through `cliIpcCall` to handlers that run inside the
 * assistant process (where the in-memory lanes can be invalidated after a
 * write). The read-only `health` report and the `set-core` cost preview also
 * route through the daemon so it stays the single source of truth for the live
 * workspace tree.
 *
 * Subcommands:
 *
 *   - `health` — print the structural health report (read-only).
 *   - `reconcile` — v1 convergence pass: rewrites any dangling page/core ref to
 *     the current on-disk tree and prunes stale core entries. It does NOT yet
 *     detect renames/moves/splits — that requires a captured prior leaf
 *     snapshot (a follow-up), so `renames` is always empty in v1.
 *   - `set-core` — add/remove always-on core leaves. Validates that every added
 *     leaf exists, previews the resulting always-on page count, and writes only
 *     on `--yes`.
 *   - `rebuild-index` — invalidate the v3 lanes so the next turn rebuilds.
 *
 * Deferred to follow-ups: thin `add-leaf` / `rename-leaf` / `delete-leaf`
 * wrappers (edit the leaf file[s] then reconcile).
 */

import type { Command } from "commander";

import { cliIpcCall } from "../../ipc/cli-client.js";
import type {
  MemoryV3HealthResult,
  MemoryV3RebuildIndexResult,
  MemoryV3ReconcileResult,
  MemoryV3SetCoreResult,
} from "../../runtime/routes/memory-v3-routes.js";
import { registerCommand } from "../lib/register-command.js";
import { log } from "../logger.js";

/** Commander collector for a repeatable option: accumulates each value. */
function collect(val: string, acc: string[]): string[] {
  acc.push(val);
  return acc;
}

export function registerMemoryV3Command(program: Command): void {
  // Reuse an existing `memory` parent if some other registrar attached to it
  // first; otherwise create one. This keeps the registration order between
  // sibling memory registrars unconstrained.
  const memory =
    program.commands.find((c) => c.name() === "memory") ??
    program.command("memory").description("Manage the memory subsystem");

  registerCommand(memory, {
    name: "v3",
    transport: "ipc",
    description: "Memory v3 tree-gardening and core-editing (leaf-tree model)",
    build: (v3) => {
      v3.addHelpText(
        "after",
        `
The v3 memory subsystem organizes concept pages under a curated leaf tree
(/workspace/memory/v3/data/) and pins an always-on "core" set of leaves.
These commands garden that tree safely: each mutating verb snapshots and
fail-closed validates before committing, and invalidates the live lanes so
the next turn rebuilds from the reconciled state.

Examples:
  $ assistant memory v3 health
  $ assistant memory v3 set-core --add domain-a/topic-x
  $ assistant memory v3 set-core --remove domain-a/topic-y --yes
  $ assistant memory v3 reconcile
  $ assistant memory v3 rebuild-index`,
      );

      // ── health ────────────────────────────────────────────────────────────

      v3.command("health")
        .description("Print the v3 structural health report (read-only)")
        .option("--json", "Emit raw JSON instead of the rendered report")
        .addHelpText(
          "after",
          `
Loads the live leaf tree + core set and reports where the taxonomy has
drifted from the page graph: unassigned slugs, dangling refs, novel
clusters, and over/under-sized leaves. Read-only — no writes. Prints
"all green" when no maintenance is warranted.

Examples:
  $ assistant memory v3 health
  $ assistant memory v3 health --json | jq '.counts'`,
        )
        .action(async (opts: { json?: boolean }) => {
          const result = await cliIpcCall<MemoryV3HealthResult>(
            "memory_v3_health",
            { body: {} },
          );
          if (!result.ok) {
            log.error(result.error ?? "Failed to compute v3 health");
            process.exitCode = 1;
            return;
          }
          const payload = result.result!;
          if (opts.json === true) {
            log.info(JSON.stringify(payload, null, 2));
            return;
          }
          log.info(
            payload.rendered === ""
              ? "memory-v3 health: all green"
              : payload.rendered,
          );
        });

      // ── reconcile ─────────────────────────────────────────────────────────

      v3.command("reconcile")
        .description(
          "v1 convergence/prune pass over page/core refs (no rename detection yet)",
        )
        .option("--json", "Emit raw JSON instead of a formatted summary")
        .addHelpText(
          "after",
          `
Runs a convergence pass over the leaf tree: rewrites any page leaves:
frontmatter or core.json entry that dangles to a path the current on-disk
tree no longer has, and prunes stale core entries. Fail-closed: snapshots
before mutating and rolls back if any dangling reference survives
validation. On success the v3 lanes are invalidated.

Limitation: v1 cannot detect renames/moves/splits. The reconciler diffs
the current tree against itself (there is no captured "before" snapshot),
so renames always report as empty and a true rename surfaces as a
delete + add. Full rename/move/split detection requires persisting a prior
leaf snapshot and is a planned follow-up.

Examples:
  $ assistant memory v3 reconcile
  $ assistant memory v3 reconcile --json | jq '.prunedCore'`,
        )
        .action(async (opts: { json?: boolean }) => {
          const result = await cliIpcCall<MemoryV3ReconcileResult>(
            "memory_v3_reconcile",
            { body: {} },
          );
          if (!result.ok) {
            log.error(result.error ?? "Failed to reconcile the v3 tree");
            process.exitCode = 1;
            return;
          }
          const payload = result.result!;
          if (opts.json === true) {
            log.info(JSON.stringify(payload, null, 2));
            return;
          }
          log.info(
            `Renamed: ${payload.renames.length === 0 ? "none" : payload.renames.length}`,
          );
          for (const r of payload.renames) {
            log.info(`  - ${r.oldPath} → ${r.newPath}`);
          }
          log.info(
            `Deleted: ${payload.deleted.length === 0 ? "none" : payload.deleted.join(", ")}`,
          );
          log.info(
            `Pruned core: ${payload.prunedCore.length === 0 ? "none" : payload.prunedCore.join(", ")}`,
          );
        });

      // ── set-core ──────────────────────────────────────────────────────────

      v3.command("set-core")
        .description(
          "Add/remove always-on core leaves (previews cost; writes on --yes)",
        )
        .option(
          "--add <leaf>",
          "Leaf path to add to the always-on core set (repeatable)",
          collect,
          [] as string[],
        )
        .option(
          "--remove <leaf>",
          "Leaf path to remove from the always-on core set (repeatable)",
          collect,
          [] as string[],
        )
        .option("--yes", "Apply the change (otherwise preview only)")
        .option("--json", "Emit raw JSON instead of a formatted summary")
        .addHelpText(
          "after",
          `
Edits the always-on core leaf set in core.json. Every --add entry must
exist in the live tree (unknown leaves are rejected). Without --yes this
PREVIEWS the resulting core set and the number of unique page slugs it
would pin always-on, WITHOUT writing. Pass --yes to persist and invalidate
the lanes.

Examples:
  $ assistant memory v3 set-core --add domain-a/topic-x        # preview
  $ assistant memory v3 set-core --add domain-a/topic-x --yes  # apply
  $ assistant memory v3 set-core --remove domain-b/topic-z --yes`,
        )
        .action(
          async (opts: {
            add: string[];
            remove: string[];
            yes?: boolean;
            json?: boolean;
          }) => {
            if (opts.add.length === 0 && opts.remove.length === 0) {
              log.error("Pass at least one --add or --remove leaf path.");
              process.exitCode = 1;
              return;
            }

            const result = await cliIpcCall<MemoryV3SetCoreResult>(
              "memory_v3_set_core",
              {
                body: {
                  add: opts.add,
                  remove: opts.remove,
                  write: opts.yes === true,
                },
              },
            );
            if (!result.ok) {
              log.error(result.error ?? "Failed to update the v3 core set");
              process.exitCode = 1;
              return;
            }
            const payload = result.result!;
            if (opts.json === true) {
              log.info(JSON.stringify(payload, null, 2));
              return;
            }
            log.info(
              `Core leaves (${payload.nextCore.length}): ${
                payload.nextCore.length === 0
                  ? "none"
                  : payload.nextCore.join(", ")
              }`,
            );
            log.info(`Always-on page count: ${payload.alwaysOnPageCount}`);
            if (payload.written) {
              log.info("Written to core.json; lanes invalidated.");
            } else {
              log.info("Preview only — re-run with --yes to apply.");
            }
          },
        );

      // ── rebuild-index ─────────────────────────────────────────────────────

      v3.command("rebuild-index")
        .description("Invalidate the v3 lanes so the next turn rebuilds")
        .addHelpText(
          "after",
          `
Drops the daemon's cached v3 shadow lanes so the tree + needle are rebuilt
from the current on-disk state on the next turn. Useful after editing leaf
files or assignments out-of-band.

Examples:
  $ assistant memory v3 rebuild-index`,
        )
        .action(async () => {
          const result = await cliIpcCall<MemoryV3RebuildIndexResult>(
            "memory_v3_rebuild_index",
            { body: {} },
          );
          if (!result.ok) {
            log.error(result.error ?? "Failed to invalidate the v3 lanes");
            process.exitCode = 1;
            return;
          }
          log.info("v3 lanes invalidated; next turn will rebuild.");
        });
    },
  });
}
