/**
 * `assistant memory v2` CLI subgroup.
 *
 * Operator-facing subcommands for the v2 memory subsystem (concept-page
 * activation model). All commands are thin wrappers over two IPC routes:
 *
 *   - `memory_v2/backfill` — enqueues one of four mutating jobs against the
 *     memory job queue (`migrate`, `rebuild-edges`, `reembed`,
 *     `activation-recompute`). Returns a `jobId` so the operator can poll
 *     status from the regular memory subsystem.
 *   - `memory_v2/validate` — read-only structural validation of the v2
 *     workspace state (concept pages + `memory/edges.json`). Returns an
 *     aggregate report of orphan edges, oversized pages, and parse failures.
 *
 * Subcommands:
 *
 *   - `migrate [--force]` — one-shot v1->v2 synthesis. Refuses to run a
 *     second time unless `--force` is passed (the migration handler writes a
 *     sentinel after a successful first run).
 *   - `rebuild-edges` — recompute every concept page's `edges:` frontmatter
 *     from the canonical `memory/edges.json` index.
 *   - `reembed` — fan out an `embed_concept_page` job per page slug to
 *     refresh dense + sparse vectors in Qdrant.
 *   - `activation` — refresh persisted activation state for every
 *     conversation that has a stored row.
 *   - `validate` — print a diagnostic report (page count, edge count, and
 *     violation lists). Does not mutate the workspace.
 *
 * Lives alongside the existing v1 `memory` command rather than replacing it
 * because v1 graph + PKB stays write-active until the cutover PR. Until the
 * `memory-v2-enabled` feature flag flips on, the workspace keeps both v1 and
 * v2 state side-by-side.
 */

import type { Command } from "commander";

import { cliIpcCall } from "../../ipc/cli-client.js";
import type {
  MemoryV2BackfillOp,
  MemoryV2BackfillResult,
} from "../../ipc/routes/memory-v2-backfill.js";
import type { MemoryV2ValidateResult } from "../../ipc/routes/memory-v2-validate.js";
import { log } from "../logger.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Issue a backfill IPC call, log the resulting `jobId`, and set a non-zero
 * exit code on failure. Centralises the error-handling boilerplate for the
 * four mutating subcommands.
 */
async function runBackfillOp(
  op: MemoryV2BackfillOp,
  opts: { force?: boolean } = {},
): Promise<void> {
  // Only forward `force: true` — the route handler already defaults missing
  // to false, so omitting the field keeps the queued JSON minimal.
  const params: Record<string, unknown> = { op };
  if (opts.force === true) params.force = true;

  const result = await cliIpcCall<MemoryV2BackfillResult>(
    "memory_v2/backfill",
    params,
  );

  if (!result.ok) {
    log.error(result.error ?? `Failed to enqueue ${op} job`);
    process.exitCode = 1;
    return;
  }

  log.info(`Queued ${op} job: ${result.result!.jobId}`);
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerMemoryV2Command(program: Command): void {
  // Attach the `v2` subgroup to the existing top-level `memory` command so
  // operators invoke it as `assistant memory v2 <op>`. The plan deliberately
  // namespaces v2 under v1 rather than promoting it to a top-level command,
  // so `assistant memory --help` surfaces both eras side-by-side until the
  // post-soak cutover removes v1.
  const memory = program.commands.find((c) => c.name() === "memory");
  if (!memory) {
    throw new Error(
      "registerMemoryV2Command: parent `memory` command not found. " +
        "Call registerMemoryCommand(program) before registerMemoryV2Command(program).",
    );
  }

  const v2 = memory
    .command("v2")
    .description("Memory v2 subsystem operations (concept-page model)");

  v2.addHelpText(
    "after",
    `
The v2 subsystem replaces the v1 graph + PKB with prose concept pages,
bidirectional edges in memory/edges.json, and activation-based retrieval.
v2 stays gated behind the memory-v2-enabled feature flag — these subcommands
remain useful operator tools regardless of whether the flag is on.

Subcommands fall into two groups:

  Mutating (return a jobId enqueued on the memory job queue):
    migrate          One-shot v1->v2 synthesis. Refuses to overwrite an
                     existing v2 state without --force.
    rebuild-edges    Regenerate every concept page's edges: frontmatter from
                     memory/edges.json.
    reembed          Refresh dense + sparse vectors for every concept page.
    activation       Refresh persisted activation state for every conversation.

  Read-only:
    validate         Print a diagnostic report of orphan edges, oversized
                     pages, and parse failures.

Examples:
  $ assistant memory v2 validate
  $ assistant memory v2 migrate
  $ assistant memory v2 migrate --force
  $ assistant memory v2 rebuild-edges
  $ assistant memory v2 reembed
  $ assistant memory v2 activation`,
  );

  // ── migrate ───────────────────────────────────────────────────────────

  v2.command("migrate")
    .description("Run the v1->v2 migration (one-shot synthesis)")
    .option(
      "-f, --force",
      "Re-run the migration even if the v2 sentinel is already present",
    )
    .addHelpText(
      "after",
      `
Synthesises v2 concept pages from the v1 graph + PKB and writes
memory/edges.json. The migration handler stores a sentinel at
memory/.v2-state/.migration-complete-v1-to-v2 after a successful run and
refuses to run again unless --force is passed.

The job runs on the background memory worker — this command returns once
the job is enqueued. Track progress via 'assistant memory status' or the
assistant logs.

Examples:
  $ assistant memory v2 migrate
  $ assistant memory v2 migrate --force`,
    )
    .action(async (opts: { force?: boolean }) => {
      await runBackfillOp("migrate", { force: opts.force });
    });

  // ── rebuild-edges ─────────────────────────────────────────────────────

  v2.command("rebuild-edges")
    .description(
      "Regenerate every concept page's edges: frontmatter from memory/edges.json",
    )
    .addHelpText(
      "after",
      `
Walks every concept page and rewrites the edges: frontmatter list to match
the canonical memory/edges.json index. Useful after a manual edit to
edges.json or to recover from a partially-written page that drifted from
the index.

The job runs on the background memory worker — this command returns once
the job is enqueued.

Examples:
  $ assistant memory v2 rebuild-edges`,
    )
    .action(async () => {
      await runBackfillOp("rebuild-edges");
    });

  // ── reembed ───────────────────────────────────────────────────────────

  v2.command("reembed")
    .description(
      "Refresh dense + sparse vectors for every concept page in Qdrant",
    )
    .addHelpText(
      "after",
      `
Fans out an embed_concept_page job per concept page slug (plus the four
reserved meta-file slugs) so each page's dense and sparse vectors get
recomputed against the current embedding backend. Useful after upgrading
the embedding model or recovering a corrupted Qdrant collection.

The fan-out runs on the background memory worker — this command returns
once the parent job is enqueued.

Examples:
  $ assistant memory v2 reembed`,
    )
    .action(async () => {
      await runBackfillOp("reembed");
    });

  // ── activation ────────────────────────────────────────────────────────

  v2.command("activation")
    .description(
      "Refresh persisted activation state for every active conversation",
    )
    .addHelpText(
      "after",
      `
Walks every conversation row in the activation_state table and
recomputes the persisted state without rendering or injecting a memory
block. Useful after tuning the activation params (d, c_user, c_assistant,
c_now, k, hops) so subsequent retrievals reflect the new weights without
waiting for organic per-turn updates.

The job runs on the background memory worker — this command returns once
the job is enqueued.

Examples:
  $ assistant memory v2 activation`,
    )
    .action(async () => {
      await runBackfillOp("activation-recompute");
    });

  // ── validate ──────────────────────────────────────────────────────────

  v2.command("validate")
    .description("Print a diagnostic report of v2 workspace state (read-only)")
    .addHelpText(
      "after",
      `
Walks every concept page and the memory/edges.json index, returning an
aggregate report of:

  pageCount             Number of concept pages successfully parsed.
  edgeCount             Number of edges in memory/edges.json.
  missingEdgeEndpoints  Edges whose endpoints reference a slug that no
                        concept page exists for (orphan endpoints).
  oversizedPages        Pages whose body exceeds memory.v2.max_page_chars
                        (a soft cap; consolidation will eventually split).
  parseFailures         Pages whose YAML frontmatter or schema validation
                        failed during read.

This is purely diagnostic — the command never mutates the workspace.

Examples:
  $ assistant memory v2 validate`,
    )
    .action(async () => {
      const result =
        await cliIpcCall<MemoryV2ValidateResult>("memory_v2/validate");

      if (!result.ok) {
        log.error(result.error ?? "Failed to validate memory v2 state");
        process.exitCode = 1;
        return;
      }

      const report = result.result!;
      log.info(`Pages: ${report.pageCount}`);
      log.info(`Edges: ${report.edgeCount}`);

      if (report.missingEdgeEndpoints.length === 0) {
        log.info("Missing edge endpoints: none");
      } else {
        log.info(
          `Missing edge endpoints: ${report.missingEdgeEndpoints.length}`,
        );
        for (const { from, to } of report.missingEdgeEndpoints) {
          log.info(`  ${from} <-> ${to}`);
        }
      }

      if (report.oversizedPages.length === 0) {
        log.info("Oversized pages: none");
      } else {
        log.info(`Oversized pages: ${report.oversizedPages.length}`);
        for (const { slug, chars } of report.oversizedPages) {
          log.info(`  ${slug} (${chars.toLocaleString()} chars)`);
        }
      }

      if (report.parseFailures.length === 0) {
        log.info("Parse failures: none");
      } else {
        log.info(`Parse failures: ${report.parseFailures.length}`);
        for (const { slug, error } of report.parseFailures) {
          log.info(`  ${slug}: ${error}`);
        }
      }
    });
}
