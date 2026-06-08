/**
 * `assistant memory v3` CLI subgroup.
 *
 * Operator-facing live-lane maintenance subcommands for the v3 memory subsystem
 * (section-lane retrieval model). The daemon owns the live shadow lanes, so the
 * verbs route through `cliIpcCall` to handlers that run inside the assistant
 * process (where the in-memory lanes can be invalidated/rebuilt after a write).
 *
 * Subcommands:
 *
 *   - `rebuild-index` — invalidate the v3 lanes so the next turn rebuilds.
 *   - `backfill-sections` — one-time: embed every page's sections (including
 *     synthetic skill/CLI rows) into the dense store, then advance the maintain
 *     checkpoint. For the transition before A/B/cutover, since the collection
 *     starts empty and the incremental maintain pass only re-embeds deltas.
 */

import type { Command } from "commander";

import { cliIpcCall } from "../../ipc/cli-client.js";
import type {
  MemoryV3BackfillSectionsResult,
  MemoryV3RebuildIndexResult,
} from "../../runtime/routes/memory-v3-routes.js";
import { registerCommand } from "../lib/register-command.js";
import { log } from "../logger.js";

/**
 * IPC timeout for `backfill-sections`. The one-time full-corpus section embed
 * runs every page's chunks through the embedder sequentially, which easily
 * outlasts `cliIpcCall`'s default 60s — so we give it a generous 30-minute
 * ceiling rather than report a spurious "Request timed out" while the assistant
 * keeps working.
 */
const BACKFILL_IPC_TIMEOUT_MS = 30 * 60 * 1000;

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
    description: "Memory v3 live-lane maintenance (section-lane model)",
    build: (v3) => {
      v3.addHelpText(
        "after",
        `
The v3 memory subsystem retrieves concept pages over section-grain lanes and
caches them as live shadow lanes inside the assistant. These commands maintain
that live state safely.

Examples:
  $ assistant memory v3 rebuild-index
  $ assistant memory v3 backfill-sections`,
      );

      // ── rebuild-index ─────────────────────────────────────────────────────

      v3.command("rebuild-index")
        .description("Invalidate the v3 lanes so the next turn rebuilds")
        .addHelpText(
          "after",
          `
Drops the assistant's cached v3 shadow lanes so the section index is rebuilt
from the current on-disk state on the next turn. Useful after editing concept
pages out-of-band.

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

      // ── backfill-sections ─────────────────────────────────────────────────

      v3.command("backfill-sections")
        .description(
          "One-time: embed every page's sections into the dense store (incl skills/CLI)",
        )
        .option("--json", "Emit raw JSON instead of a formatted summary")
        .addHelpText(
          "after",
          `
Embeds EVERY concept page's sections — including synthetic skill and CLI
capability rows — into the section dense store in one pass, then advances
the maintain checkpoint so the next incremental pass only re-embeds future
edits. Use this once on an existing install before the section-lane A/B and
cutover: the dense collection starts empty, and the periodic maintenance
pass only re-embeds pages edited since its last run (and never the synthetic
rows), so most of the corpus would otherwise never be embedded.

Idempotent and safe to re-run. Runs inside the assistant so it uses the live
configuration and advances the checkpoint the assistant reads.

Examples:
  $ assistant memory v3 backfill-sections
  $ assistant memory v3 backfill-sections --json | jq '.sections'`,
        )
        .action(async (opts: { json?: boolean }) => {
          const result = await cliIpcCall<MemoryV3BackfillSectionsResult>(
            "memory_v3_backfill_sections",
            { body: {} },
            { timeoutMs: BACKFILL_IPC_TIMEOUT_MS },
          );
          if (!result.ok) {
            log.error(result.error ?? "Failed to backfill section embeddings");
            process.exitCode = 1;
            return;
          }
          const payload = result.result!;
          if (opts.json === true) {
            log.info(JSON.stringify(payload, null, 2));
            return;
          }
          log.info(
            `Embedded ${payload.sections} sections across ${payload.articles} pages` +
              (payload.failures > 0
                ? ` (${payload.failures} page(s) failed — see assistant logs).`
                : "."),
          );
        });
    },
  });
}
