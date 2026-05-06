/**
 * `assistant memory v2` CLI subgroup.
 *
 * Operator-facing subcommands for the v2 memory subsystem (concept-page
 * activation model). All commands are thin wrappers over two IPC routes:
 *
 *   - `memory_v2/backfill` — enqueues one of three mutating jobs against the
 *     memory job queue (`migrate`, `reembed`, `activation-recompute`).
 *     Returns a `jobId` so the operator can poll status from the regular
 *     memory subsystem.
 *   - `memory_v2/validate` — read-only structural validation of the v2
 *     workspace state. Returns an aggregate report of orphan outgoing-edge
 *     targets, oversized pages, and parse failures.
 *
 * Subcommands:
 *
 *   - `migrate [--force]` — one-shot v1->v2 synthesis. Refuses to run a
 *     second time unless `--force` is passed (the migration handler writes a
 *     sentinel after a successful first run).
 *   - `reembed` — fan out an `embed_concept_page` job per page slug to
 *     refresh dense + sparse vectors in Qdrant.
 *   - `activation` — refresh persisted activation state for every
 *     conversation that has a stored row.
 *   - `validate` — print a diagnostic report (page count, edge count, and
 *     violation lists). Does not mutate the workspace.
 *
 * Lives alongside the existing v1 `memory` command rather than replacing it
 * so flipping `memory.v2.enabled` back to false fully re-engages the v1
 * pipeline. While v2 is on, v1 graph extraction/maintenance and PKB filing
 * are suppressed; v1 data stays in place but stops being updated.
 */

import type { Command } from "commander";

import { cliIpcCall } from "../../ipc/cli-client.js";
import type {
  MemoryV2BackfillOp,
  MemoryV2BackfillResult,
  MemoryV2ExplainSimilarityResult,
  MemoryV2ExplainSimilarityStats,
  MemoryV2FitAnisotropyResult,
  MemoryV2RebuildCorpusStatsResult,
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
    "memory_v2_backfill",
    { body: params },
  );

  if (!result.ok) {
    log.error(result.error ?? `Failed to enqueue ${op} job`);
    process.exitCode = 1;
    return;
  }

  log.info(`Queued ${op} job: ${result.result!.jobId}`);
}

/** Format a number for table output. */
function fmt(n: number | null, decimals: number): string {
  if (n === null) return "—";
  return n.toFixed(decimals);
}

/** Render the per-channel breakdown table + stats for the explain command. */
function printExplainResult(result: MemoryV2ExplainSimilarityResult): void {
  log.info(
    `dense_weight=${result.config.dense_weight}  sparse_weight=${result.config.sparse_weight}`,
  );

  for (const channel of result.channels) {
    log.info("");
    log.info(`── channel: ${channel.channel} ──`);
    log.info(`text: ${channel.textPreview}`);
    log.info(
      `maxSparse (used for normalization): ${channel.maxSparse.toFixed(4)}`,
    );
    log.info(
      `effective: dw=${channel.effectiveDenseWeight.toFixed(3)} sw=${channel.effectiveSparseWeight.toFixed(3)} (sparseSpread=${channel.sparseSpread.toFixed(3)})`,
    );
    log.info("");
    log.info(
      "slug".padEnd(48) +
        "dense".padStart(10) +
        "sparseRaw".padStart(12) +
        "sparseNorm".padStart(12) +
        "fused".padStart(10),
    );
    log.info("─".repeat(92));
    for (const row of channel.rows) {
      const slugCol =
        row.slug.length > 47 ? `${row.slug.slice(0, 46)}…` : row.slug;
      log.info(
        slugCol.padEnd(48) +
          fmt(row.denseScore, 4).padStart(10) +
          fmt(row.sparseRaw, 4).padStart(12) +
          fmt(row.sparseNorm, 4).padStart(12) +
          fmt(row.fused, 4).padStart(10),
      );
    }
    log.info("");
    log.info("Stats (per channel):");
    log.info(`  ${formatStatLine("dense       ", channel.stats.dense)}`);
    log.info(`  ${formatStatLine("sparseRaw   ", channel.stats.sparseRaw)}`);
    log.info(`  ${formatStatLine("sparseNorm  ", channel.stats.sparseNorm)}`);
    log.info(`  ${formatStatLine("fused       ", channel.stats.fused)}`);
  }
}

function formatStatLine(
  label: string,
  stats: MemoryV2ExplainSimilarityStats,
): string {
  if (stats.count === 0) {
    return `${label} n=0`;
  }
  const range = stats.max - stats.min;
  return (
    `${label} n=${String(stats.count).padStart(3)}` +
    ` range=[${stats.min.toFixed(4)}, ${stats.max.toFixed(4)}]` +
    ` (Δ=${range.toFixed(4)})` +
    ` mean=${stats.mean.toFixed(4)}` +
    ` std=${stats.stddev.toFixed(4)}`
  );
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
directed edges stored in each page's frontmatter, and activation-based
retrieval. v2 is gated behind the memory.v2.enabled config field —
these subcommands remain useful operator tools regardless of whether
v2 is currently active.

Subcommands fall into three groups:

  Mutating (return a jobId enqueued on the memory job queue):
    migrate          One-shot v1->v2 synthesis. Refuses to overwrite an
                     existing v2 state without --force.
    reembed          Refresh dense + sparse vectors for every concept page.
    activation       Refresh persisted activation state for every conversation.

  Mutating (synchronous — runs inside the daemon and returns when done):
    reembed-skills   Re-seed v2 skill entries from the current skill catalog.

  Read-only:
    validate         Print a diagnostic report of orphan outgoing-edge
                     targets, oversized pages, and parse failures.

  Calibration:
    fit-anisotropy   Fit Mu & Viswanath's all-but-the-top correction so
                     embedding cosines stop clustering in a narrow band.

Examples:
  $ assistant memory v2 validate
  $ assistant memory v2 migrate
  $ assistant memory v2 migrate --force
  $ assistant memory v2 reembed
  $ assistant memory v2 reembed-skills
  $ assistant memory v2 activation
  $ assistant memory v2 fit-anisotropy`,
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
Synthesises v2 concept pages from the v1 graph + PKB, writing each page's
outgoing directed edges directly into its frontmatter. The migration handler
stores a sentinel at memory/.v2-state/.migration-complete-v1-to-v2 after a
successful run and refuses to run again unless --force is passed.

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
daemon — the command returns only once the seed completes. Requires
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

  // ── explain ───────────────────────────────────────────────────────────

  v2.command("explain")
    .description(
      "Diagnose dense vs sparse score distributions for a query (read-only)",
    )
    .requiredOption(
      "--text <text>",
      "Query text to embed and score against the concept-page collection (the user channel).",
    )
    .option(
      "--assistant-text <text>",
      "Optional second query text — scored independently as the assistant channel.",
    )
    .option(
      "--now-text <text>",
      "Optional third query text — scored independently as the now channel.",
    )
    .option(
      "--top <n>",
      "Number of top hits to fetch per channel (default 25)",
      "25",
    )
    .addHelpText(
      "after",
      `
Embeds the supplied text(s), runs the hybrid dense + sparse query against
the v2 concept-page Qdrant collection, and prints per-slug raw dense, raw
sparse, normalized sparse, and fused scores plus per-channel summary
statistics (range, mean, stddev). Use this to identify whether dense
embedding compression (anisotropy) or per-batch sparse normalization is
the dominant cause of score compression at the head of the activation
distribution.

Read-only: does not mutate Qdrant, the workspace, or the activation log.

Interpretation:
  Dense range  < 0.1  AND sparseNorm range > 0.5 → embedding anisotropy
  Dense range  > 0.2  AND sparseNorm range < 0.1 → sparse max-normalization
  Both compressed                                → both contribute
  Both wide                                      → channel mixing is the cause

Examples:
  $ assistant memory v2 explain --text "what's bothering me"
  $ assistant memory v2 explain --text "..." --top 50
  $ assistant memory v2 explain --text "..." --assistant-text "..." --now-text "..."`,
    )
    .action(
      async (opts: {
        text: string;
        assistantText?: string;
        nowText?: string;
        top: string;
      }) => {
        const top = Number.parseInt(opts.top, 10);
        if (!Number.isFinite(top) || top < 1) {
          log.error("--top must be a positive integer");
          process.exitCode = 1;
          return;
        }

        const result = await cliIpcCall<MemoryV2ExplainSimilarityResult>(
          "memory_v2_explain_similarity",
          {
            body: {
              userText: opts.text,
              assistantText: opts.assistantText,
              nowText: opts.nowText,
              top,
            },
          },
        );

        if (!result.ok) {
          log.error(result.error ?? "Failed to run similarity diagnostic");
          process.exitCode = 1;
          return;
        }

        printExplainResult(result.result!);
      },
    );

  // ── rebuild-corpus-stats ──────────────────────────────────────────────

  v2.command("rebuild-corpus-stats")
    .description(
      "Rebuild the BM25 corpus stats (DF table + avg doc length) used by the sparse channel",
    )
    .addHelpText(
      "after",
      `
Walks every concept page on disk and recomputes the document-frequency
table and average document length used to weight BM25 sparse vectors.
Atomic swap — the previous stats stay live until the new ones are ready.

Run after bulk content imports, after manually editing many pages, or to
recover from a startup rebuild that errored.

Note: this only refreshes the in-memory stats used to *construct* new
document-side sparse vectors. Existing sparse vectors stored in Qdrant
are not refreshed by this command — pair with 'assistant memory v2
reembed' if document-side weights need updating.

Examples:
  $ assistant memory v2 rebuild-corpus-stats`,
    )
    .action(async () => {
      const result = await cliIpcCall<MemoryV2RebuildCorpusStatsResult>(
        "memory_v2_rebuild_corpus_stats",
        { body: {} },
      );

      if (!result.ok) {
        log.error(result.error ?? "Failed to rebuild corpus stats");
        process.exitCode = 1;
        return;
      }

      const r = result.result!;
      log.info(`Rebuilt BM25 corpus stats: ${r.totalDocs} docs.`);
      log.info(`  avg doc length: ${r.avgDl.toFixed(2)} tokens`);
      log.info(`  vocabulary buckets: ${r.vocabularyBuckets.toLocaleString()}`);
    });

  // ── fit-anisotropy ────────────────────────────────────────────────────

  v2.command("fit-anisotropy")
    .description(
      "Fit the embedding anisotropy correction (Mu & Viswanath 'all-but-the-top')",
    )
    .option(
      "--k <n>",
      "Number of leading principal components to project out (default 1; raise to 2-3 only if PC2/PC3 also explain >5% variance)",
      "1",
    )
    .option(
      "--sample <n>",
      "Maximum stored dense vectors to pull for the fit (default 5000)",
      "5000",
    )
    .addHelpText(
      "after",
      `
Modern transformer embeddings (Gemini in particular) are anisotropic — every
vector lives in a narrow cone of the embedding space, which compresses cosine
similarities into a tight band (typically 0.4-0.7) and lets a few dominant
directions drown out semantic signal.

This command samples stored dense vectors from the concept-page Qdrant
collection, fits a corpus mean + top-k principal components, and persists the
calibration. Subsequent embeds and queries apply the correction automatically:

  vec' = vec - mean
  for each pc_i: vec' = vec' - (vec' · pc_i) pc_i
  vec' = vec' / ||vec'||

After fitting, run 'assistant memory v2 reembed' to re-process every stored
concept page through the new calibration. Until then, queries are corrected
but stored vectors are not — the score range stays the same and retrieval may
degrade. The calibration is keyed by (provider, model, dim), so changing
embedding model invalidates it.

Recommended k:
  k=1   safest default. Removes the dominant common direction.
  k=2-3 only when explained-variance ratios show PC2/PC3 each above ~5%.
  k>3   not justified without a labeled retrieval eval set.

Examples:
  $ assistant memory v2 fit-anisotropy
  $ assistant memory v2 fit-anisotropy --k 2
  $ assistant memory v2 fit-anisotropy --sample 10000`,
    )
    .action(async (opts: { k: string; sample: string }) => {
      const k = Number.parseInt(opts.k, 10);
      const sample = Number.parseInt(opts.sample, 10);
      if (!Number.isFinite(k) || k < 1) {
        log.error("--k must be a positive integer");
        process.exitCode = 1;
        return;
      }
      if (!Number.isFinite(sample) || sample < 1) {
        log.error("--sample must be a positive integer");
        process.exitCode = 1;
        return;
      }

      const result = await cliIpcCall<MemoryV2FitAnisotropyResult>(
        "memory_v2_fit_anisotropy",
        { body: { k, sample } },
      );

      if (!result.ok) {
        log.error(result.error ?? "Failed to fit anisotropy calibration");
        process.exitCode = 1;
        return;
      }

      const r = result.result!;
      log.info(
        `Fit anisotropy calibration: ${r.provider}/${r.model} (dim=${r.dim})`,
      );
      log.info(`  samples: ${r.sampleCount}`);
      log.info(`  total variance: ${r.totalVariance.toFixed(6)}`);
      log.info("  explained variance per component:");
      for (let i = 0; i < r.componentVariance.length; i++) {
        const ratio = (r.explainedVarianceRatio[i] * 100).toFixed(2);
        log.info(
          `    PC${i + 1}: ${r.componentVariance[i].toFixed(6)} (${ratio}%)`,
        );
      }
      log.info(`  written to: ${r.path}`);
      log.info("");
      log.info(
        "Next step: run 'assistant memory v2 reembed' so every stored concept page is re-written under the new calibration. Until then, query-side correction operates on stored vectors that were embedded without it.",
      );
    });

  // ── validate ──────────────────────────────────────────────────────────

  v2.command("validate")
    .description("Print a diagnostic report of v2 workspace state (read-only)")
    .addHelpText(
      "after",
      `
Walks every concept page and aggregates outgoing edges from each page's
frontmatter, returning a diagnostic report of:

  pageCount             Number of concept pages successfully parsed.
  edgeCount             Total number of directed outgoing edges across pages.
  missingEdgeEndpoints  Outgoing edges whose target slug has no
                        corresponding concept page (orphan targets).
  oversizedPages        Pages whose body exceeds memory.v2.max_page_chars
                        (a soft cap; consolidation will eventually split).
  parseFailures         Pages whose YAML frontmatter or schema validation
                        failed during read.

This is purely diagnostic — the command never mutates the workspace.

Examples:
  $ assistant memory v2 validate`,
    )
    .action(async () => {
      const result = await cliIpcCall<MemoryV2ValidateResult>(
        "memory_v2_validate",
        {
          body: {},
        },
      );

      if (!result.ok) {
        log.error(result.error ?? "Failed to validate memory v2 state");
        process.exitCode = 1;
        return;
      }

      const report = result.result!;
      log.info(`Pages: ${report.pageCount}`);
      log.info(`Edges: ${report.edgeCount}`);

      if (report.missingEdgeEndpoints.length === 0) {
        log.info("Missing outgoing edge targets: none");
      } else {
        log.info(
          `Missing outgoing edge targets: ${report.missingEdgeEndpoints.length}`,
        );
        for (const { from, to } of report.missingEdgeEndpoints) {
          log.info(`  ${from} -> ${to}`);
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
