/**
 * `assistant memory v2` CLI subgroup.
 *
 * Operator-facing subcommands for the v2 memory subsystem (concept-page
 * activation model).
 *
 * Subcommands:
 *
 *   - `reembed` — fan out an `embed_concept_page` job per page slug to
 *     refresh dense + sparse vectors in Qdrant.
 *   - `reembed-skills` — synchronously re-seed v2 skill catalog entries
 *     from the current skill set.
 *   - `activation` — refresh persisted activation state for every
 *     conversation that has a stored row.
 *   - `validate` — print a diagnostic report (page count, edge count, and
 *     violation lists). Does not mutate the workspace.
 */

import type { Command } from "commander";

import { cliIpcCall } from "../../ipc/cli-client.js";
import type {
  MemoryV2BackfillOp,
  MemoryV2BackfillResult,
  MemoryV2ReembedSkillsResult,
  MemoryV2ValidateResult,
} from "../../runtime/routes/memory-v2-routes.js";
import { log } from "../logger.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Issue a backfill IPC call, log the resulting `jobId`, and set a non-zero
 * exit code on failure. Centralises the error-handling boilerplate for the
 * mutating subcommands.
 */
async function runBackfillOp(op: MemoryV2BackfillOp): Promise<void> {
  const result = await cliIpcCall<MemoryV2BackfillResult>(
    "memory_v2_backfill",
    { body: { op } },
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
  // Reuse an existing `memory` parent if some other registrar attached to it
  // first; otherwise create one. This keeps the registration order between
  // sibling memory registrars unconstrained.
  const memory =
    program.commands.find((c) => c.name() === "memory") ??
    program
      .command("memory")
      .description("Manage the v2 memory subsystem (concept-page model)");

  const v2 = memory
    .command("v2")
    .description("Memory v2 subsystem operations");

  v2.addHelpText(
    "after",
    `
The v2 memory subsystem stores prose concept pages with directed edges in
each page's frontmatter and uses activation-based retrieval. Pages live
under /workspace/memory/concepts/ and are gated behind the
memory.v2.enabled config field.

Mutating subcommands return a jobId enqueued on the memory job queue,
except reembed-skills which runs synchronously inside the assistant.
Read-only subcommands print diagnostic reports without mutating state.

Examples:
  $ assistant memory v2 validate
  $ assistant memory v2 reembed
  $ assistant memory v2 reembed-skills
  $ assistant memory v2 activation`,
  );

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

  // ── reembed-skills ────────────────────────────────────────────────────

  v2.command("reembed-skills")
    .description(
      "Re-seed v2 skill entries from the current skill catalog (synchronous)",
    )
    .addHelpText(
      "after",
      `
Re-runs the v2 skill catalog seed against the current skill set, replacing
both the in-process skill cache and the skill entries in the unified
memory_v2_concept_pages Qdrant collection (under the skills/<id> slug
prefix). Useful after editing a skill's SKILL.md, after a feature-flag flip
changes the enabled-skill set, or to recover corrupted skill embeddings.

Unlike 'reembed' (concept pages), this runs synchronously inside the
assistant — the command returns only once the seed completes. Requires
memory.v2.enabled to be true.

Examples:
  $ assistant memory v2 reembed-skills`,
    )
    .action(async () => {
      const result = await cliIpcCall<MemoryV2ReembedSkillsResult>(
        "memory_v2_reembed_skills",
        { body: {} },
      );

      if (!result.ok) {
        log.error(result.error ?? "Failed to re-seed v2 skill entries");
        process.exitCode = 1;
        return;
      }

      log.info("Skill re-seed complete.");
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
Walks the v2 concept-page tree on disk and reports:
  - Page count
  - Edge count (total and unique outgoing targets)
  - Missing outgoing edge targets (orphan edges)
  - Oversized pages (over the per-folder size cap)
  - Parse failures (missing or malformed frontmatter)

Read-only — does not mutate the workspace. Exits non-zero if any
violations are reported.

Examples:
  $ assistant memory v2 validate`,
    )
    .action(async () => {
      const result = await cliIpcCall<MemoryV2ValidateResult>(
        "memory_v2_validate",
        { body: {} },
      );

      if (!result.ok) {
        log.error(result.error ?? "Failed to validate memory v2 state");
        process.exitCode = 1;
        return;
      }

      const report = result.result!;
      log.info(`Pages: ${report.pageCount}`);
      log.info(`Edges: ${report.edgeCount}`);
      log.info(
        `Missing edge endpoints: ${
          report.missingEdgeEndpoints.length === 0
            ? "none"
            : report.missingEdgeEndpoints.length
        }`,
      );
      for (const m of report.missingEdgeEndpoints) {
        log.info(`  - ${m.from} → ${m.to}`);
      }
      log.info(
        `Oversized pages: ${
          report.oversizedPages.length === 0
            ? "none"
            : report.oversizedPages.length
        }`,
      );
      for (const p of report.oversizedPages) {
        log.info(`  - ${p.slug}: ${p.chars} chars`);
      }
      log.info(
        `Parse failures: ${
          report.parseFailures.length === 0
            ? "none"
            : report.parseFailures.length
        }`,
      );
      for (const p of report.parseFailures) {
        log.info(`  - ${p.slug}: ${p.error}`);
      }

      if (
        report.missingEdgeEndpoints.length > 0 ||
        report.oversizedPages.length > 0 ||
        report.parseFailures.length > 0
      ) {
        process.exitCode = 1;
      }
    });
}
