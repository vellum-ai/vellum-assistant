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
import type { ComparisonReport } from "../../memory/v2/harness/runner.js";
import type {
  MemoryV2BackfillOp,
  MemoryV2BackfillResult,
  MemoryV2EmaScoresResult,
  MemoryV2ReembedSkillsResult,
  MemoryV2SimulateRouterResult,
  MemoryV2ValidateResult,
} from "../../runtime/routes/memory-v2-routes.js";
import { registerCommand } from "../lib/register-command.js";
import { log } from "../logger.js";
import {
  renderComparisonReport,
  renderTurnTrace,
} from "./memory-v2-compare-render.js";

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

  registerCommand(memory, {
    name: "v2",
    transport: "ipc",
    description: "Memory v2 subsystem operations (concept-page model)",
    build: (v2) => {
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
        .description(
          "Print a diagnostic report of v2 workspace state (read-only)",
        )
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

      // ── ema ───────────────────────────────────────────────────────────────

      v2.command("ema")
        .description(
          "List concept pages by injection-frequency EMA score (read-only)",
        )
        .option(
          "-n, --limit <count>",
          "Maximum rows to print (default 25; ignored with --all)",
          "25",
        )
        .option("--all", "Print every page, including zero-score pages")
        .option(
          "--include-zeros",
          "Include pages with score 0 in the default-limited view",
        )
        .option("--json", "Emit raw JSON instead of a formatted table")
        .addHelpText(
          "after",
          `
EMA score is the time-decayed sum Σ exp(-λ × (now - tᵢ)) with a 3-day
half-life, computed from memory_v2_injection_events. A score of 1.0 means
roughly one router selection in the last few minutes; 0.5 means a single
selection ~3 days ago. Pages that have never been router-selected since
EMA tracking began report 0.

Examples:
  $ assistant memory v2 ema
  $ assistant memory v2 ema -n 100
  $ assistant memory v2 ema --all --json | jq '.entries | length'`,
        )
        .action(
          async (opts: {
            limit: string;
            all?: boolean;
            includeZeros?: boolean;
            json?: boolean;
          }) => {
            const result = await cliIpcCall<MemoryV2EmaScoresResult>(
              "memory_v2_ema_scores",
              { body: {} },
            );

            if (!result.ok) {
              log.error(result.error ?? "Failed to fetch EMA scores");
              process.exitCode = 1;
              return;
            }

            const allEntries = result.result!.entries;
            const includeZeros =
              opts.all === true || opts.includeZeros === true;
            const visible = includeZeros
              ? allEntries
              : allEntries.filter((e) => e.score > 0);

            const limit =
              opts.all === true ? visible.length : Number(opts.limit);
            if (!opts.all && (!Number.isFinite(limit) || limit < 1)) {
              log.error(
                `--limit must be a positive integer (got "${opts.limit}")`,
              );
              process.exitCode = 1;
              return;
            }
            const rows = visible.slice(0, limit);

            if (opts.json === true) {
              log.info(
                JSON.stringify(
                  {
                    entries: rows,
                    totalScored: allEntries.filter((e) => e.score > 0).length,
                    totalPages: allEntries.length,
                  },
                  null,
                  2,
                ),
              );
              return;
            }

            if (rows.length === 0) {
              log.info(
                "No concept pages have any EMA signal yet. Send a few turns through the router and try again.",
              );
              return;
            }

            const slugWidth = Math.min(
              60,
              Math.max(...rows.map((r) => r.slug.length)),
            );
            const header = `${"slug".padEnd(slugWidth)}  ${"score".padStart(8)}  modified`;
            log.info(header);
            log.info("-".repeat(header.length));
            for (const row of rows) {
              const slug =
                row.slug.length > slugWidth
                  ? row.slug.slice(0, slugWidth - 1) + "…"
                  : row.slug.padEnd(slugWidth);
              const score = row.score.toFixed(3).padStart(8);
              const modified =
                row.modifiedAt > 0
                  ? new Date(row.modifiedAt).toISOString().slice(0, 10)
                  : "—";
              log.info(`${slug}  ${score}  ${modified}`);
            }
            const totalScored = allEntries.filter((e) => e.score > 0).length;
            log.info(
              `\n${rows.length} of ${visible.length} shown (${totalScored} total with score > 0, ${allEntries.length} pages indexed).`,
            );
          },
        );

      // ── simulate ──────────────────────────────────────────────────────────

      v2.command("simulate")
        .description(
          "Dry-run the v4 router against a synthetic query (read-only)",
        )
        .requiredOption(
          "-q, --query <text>",
          "User query to route the simulated turn against",
        )
        .option(
          "--tier1-size <n>",
          "Override memory.v2.router.tier1_size for this run (number or 'null')",
        )
        .option(
          "--tier2-size <n>",
          "Override memory.v2.router.tier2_size for this run (number or 'null')",
        )
        .option(
          "--batch-size <n>",
          "Override memory.v2.router.batch_size for this run (number or 'null')",
        )
        .option("--json", "Emit raw JSON instead of a grouped report")
        .addHelpText(
          "after",
          `
Runs the v4 router read-only against the live page index + EMA scores, with
optional tier/batch overrides applied on top of the live config. NO writes:
no row is appended to memory_v2_injection_events or memory_v2_activation_logs,
and no activation state is mutated. Use this to preview the effect of a
config knob change before flipping it in workspace config.json.

Limitations:
  - priorEverInjected is empty (single-turn simulation; live router dedups
    against pages already in context).
  - NOW.md is read at simulate-time, not historical-turn time.
  - assistantMessage is empty.

Pass 'null' to an override flag to explicitly disable that tier for this run
(e.g. --tier2-size null reverts to tier1 → tier3). Omitting an override
inherits the live config value.

Examples:
  $ assistant memory v2 simulate -q "what should we ship next"
  $ assistant memory v2 simulate -q "..." --tier1-size 100 --tier2-size 200 --batch-size 50
  $ assistant memory v2 simulate -q "..." --json | jq '.selectedSlugs'`,
        )
        .action(
          async (opts: {
            query: string;
            tier1Size?: string;
            tier2Size?: string;
            batchSize?: string;
            json?: boolean;
          }) => {
            const parseOverride = (
              flag: string,
              raw: string | undefined,
            ): number | null | undefined => {
              if (raw === undefined) return undefined;
              if (raw === "null") return null;
              const parsed = Number(raw);
              if (!Number.isInteger(parsed) || parsed < 1) {
                log.error(
                  `${flag} must be a positive integer or 'null' (got "${raw}")`,
                );
                process.exitCode = 1;
                throw new Error("invalid-override");
              }
              return parsed;
            };

            let configOverrides:
              | {
                  tier1_size?: number | null;
                  tier2_size?: number | null;
                  batch_size?: number | null;
                }
              | undefined;
            try {
              const t1 = parseOverride("--tier1-size", opts.tier1Size);
              const t2 = parseOverride("--tier2-size", opts.tier2Size);
              const bs = parseOverride("--batch-size", opts.batchSize);
              configOverrides = {
                ...(t1 !== undefined ? { tier1_size: t1 } : {}),
                ...(t2 !== undefined ? { tier2_size: t2 } : {}),
                ...(bs !== undefined ? { batch_size: bs } : {}),
              };
              if (Object.keys(configOverrides).length === 0) {
                configOverrides = undefined;
              }
            } catch {
              return;
            }

            const result = await cliIpcCall<MemoryV2SimulateRouterResult>(
              "memory_v2_simulate_router",
              {
                body: {
                  // The CLI flag is still named `--query` for backwards
                  // compatibility. It becomes the just-arrived
                  // `userMessage` of a single (empty assistant, user)
                  // pair — i.e. a first-turn scenario. nowText uses
                  // the server default (live NOW.md), preserving the
                  // existing single-turn CLI semantics.
                  recentTurnPairs: [
                    { assistantMessage: "", userMessage: opts.query },
                  ],
                  ...(configOverrides ? { configOverrides } : {}),
                },
              },
            );

            if (!result.ok) {
              log.error(result.error ?? "Failed to simulate router");
              process.exitCode = 1;
              return;
            }

            const payload = result.result!;

            if (opts.json === true) {
              log.info(JSON.stringify(payload, null, 2));
              return;
            }

            log.info("Memory Router Simulation");
            log.info("========================");
            log.info(`Query: ${JSON.stringify(opts.query)}`);
            log.info("");
            log.info("Config (effective):");
            const formatKnob = (
              key: keyof MemoryV2SimulateRouterResult["effectiveConfig"],
            ): string => {
              const eff = payload.effectiveConfig[key];
              const override = (
                payload.overrides as Record<string, number | null | undefined>
              )[key];
              const effStr = eff === null ? "null" : String(eff);
              if (override === undefined) {
                return `  ${key}: ${effStr}`;
              }
              return `  ${key}: ${effStr}  (override)`;
            };
            log.info(formatKnob("tier1_size"));
            log.info(formatKnob("tier2_size"));
            log.info(formatKnob("batch_size"));
            log.info(`  max_page_ids: ${payload.effectiveConfig.max_page_ids}`);
            log.info("");
            log.info(`Total candidate pages: ${payload.totalCandidatePages}`);
            log.info(
              `Selected: ${payload.selectedSlugs.length} / ${payload.effectiveConfig.max_page_ids} pages`,
            );
            if (payload.failureReason) {
              log.info(`Failure: ${payload.failureReason}`);
            }
            log.info("");

            const grouped = new Map<string, string[]>();
            for (const slug of payload.selectedSlugs) {
              const source = payload.sourceBySlug[slug] ?? "unknown";
              const bucket = grouped.get(source) ?? [];
              bucket.push(slug);
              grouped.set(source, bucket);
            }
            const sortedKeys = [...grouped.keys()].sort((a, b) => {
              const order = (s: string) => {
                if (s === "tier1") return 0;
                if (s === "tier2") return 1;
                if (s.startsWith("tier3:")) {
                  return 2 + Number(s.slice("tier3:".length));
                }
                return Number.MAX_SAFE_INTEGER;
              };
              return order(a) - order(b);
            });

            for (const key of sortedKeys) {
              const label = key.startsWith("tier3:")
                ? `tier 3 · b${key.slice("tier3:".length)}`
                : key === "tier1"
                  ? "tier 1"
                  : key === "tier2"
                    ? "tier 2"
                    : key;
              log.info(label);
              for (const slug of grouped.get(key)!) {
                if (key === "tier2") {
                  const score = payload.scores[slug] ?? 0;
                  log.info(`  - ${slug}  (EMA ${score.toFixed(3)})`);
                } else {
                  log.info(`  - ${slug}`);
                }
              }
              log.info("");
            }
          },
        );

      // ── compare ─────────────────────────────────────────────────────────

      v2.command("compare")
        .description(
          "Compare retrievers against the router's logged picks over a sample of real turns (read-only)",
        )
        .option(
          "--limit <n>",
          "How many historical turns to sample (default 20). Each re-runs the router = one LLM call.",
        )
        .option(
          "--strategy <recent|random>",
          "Sampling strategy over historical turns (default recent)",
        )
        .option(
          "--k <list>",
          "Comma-separated recall@k cutoffs (default 5,10,25,50)",
        )
        .option(
          "--conversation <id>",
          "Restrict to a conversation id (repeatable)",
          (val: string, acc: string[]) => {
            acc.push(val);
            return acc;
          },
          [] as string[],
        )
        .option(
          "--trace <conversationId:turn>",
          "Print the per-retriever breakdown for one scored turn",
        )
        .option(
          "--include-not-injected",
          "Also count router picks cut by the injection cap as ground truth",
        )
        .option("--json", "Emit raw JSON instead of a formatted report")
        .addHelpText(
          "after",
          `
Runs the comparison harness read-only: samples historical 'router'-mode turns
from memory_v2_activation_logs, reconstructs each turn's inputs, re-runs each
retriever, and scores selections against the logged picks (recall@k). NO writes.

Cost: each scored turn re-runs the router (one LLM call), so --limit is the
cost knob — start small. Today the only retriever is the router itself, so this
is the harness self-test (router graded against its own logged picks); the gap
from 1.0 is input-reconstruction drift (NOW.md / config moved since the turn).

Examples:
  $ assistant memory v2 compare --limit 20
  $ assistant memory v2 compare --limit 50 --strategy random --k 5,10,25
  $ assistant memory v2 compare --limit 20 --trace conv-abc:7
  $ assistant memory v2 compare --limit 20 --json | jq '.retrievers[0].aggregate'`,
        )
        .action(
          async (opts: {
            limit?: string;
            strategy?: string;
            k?: string;
            conversation?: string[];
            trace?: string;
            includeNotInjected?: boolean;
            json?: boolean;
          }) => {
            let limit: number | undefined;
            if (opts.limit !== undefined) {
              const parsed = Number(opts.limit);
              if (!Number.isInteger(parsed) || parsed < 1) {
                log.error(
                  `--limit must be a positive integer (got "${opts.limit}")`,
                );
                process.exitCode = 1;
                return;
              }
              limit = parsed;
            }

            if (
              opts.strategy !== undefined &&
              opts.strategy !== "recent" &&
              opts.strategy !== "random"
            ) {
              log.error(
                `--strategy must be "recent" or "random" (got "${opts.strategy}")`,
              );
              process.exitCode = 1;
              return;
            }

            let ks: number[] | undefined;
            if (opts.k !== undefined) {
              ks = opts.k.split(",").map((s) => Number(s.trim()));
              if (ks.some((k) => !Number.isInteger(k) || k < 1)) {
                log.error(
                  `--k must be a comma-separated list of positive integers (got "${opts.k}")`,
                );
                process.exitCode = 1;
                return;
              }
            }

            const conversationIds =
              opts.conversation && opts.conversation.length > 0
                ? opts.conversation
                : undefined;

            const result = await cliIpcCall<ComparisonReport>(
              "memory_v2_compare_retrievers",
              {
                body: {
                  ...(limit !== undefined ? { limit } : {}),
                  ...(opts.strategy !== undefined
                    ? { strategy: opts.strategy }
                    : {}),
                  ...(ks !== undefined ? { ks } : {}),
                  ...(conversationIds !== undefined ? { conversationIds } : {}),
                  ...(opts.includeNotInjected === true
                    ? { includeNotInjected: true }
                    : {}),
                },
              },
            );

            if (!result.ok) {
              log.error(result.error ?? "Failed to compare retrievers");
              process.exitCode = 1;
              return;
            }

            const payload = result.result!;

            if (opts.json === true) {
              log.info(JSON.stringify(payload, null, 2));
              return;
            }

            log.info(renderComparisonReport(payload));

            if (opts.trace !== undefined) {
              const sep = opts.trace.lastIndexOf(":");
              if (sep <= 0 || sep === opts.trace.length - 1) {
                log.error(
                  `--trace must be "<conversationId>:<turn>" (got "${opts.trace}")`,
                );
                process.exitCode = 1;
                return;
              }
              const conversationId = opts.trace.slice(0, sep);
              const turn = Number(opts.trace.slice(sep + 1));
              if (!Number.isInteger(turn)) {
                log.error(
                  `--trace turn must be an integer (got "${opts.trace.slice(sep + 1)}")`,
                );
                process.exitCode = 1;
                return;
              }
              log.info("");
              log.info(renderTurnTrace(payload, conversationId, turn));
            }
          },
        );
    },
  });
}
