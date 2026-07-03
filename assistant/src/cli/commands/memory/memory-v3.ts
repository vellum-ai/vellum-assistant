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

import { readFileSync, writeFileSync } from "node:fs";

import type { Command } from "commander";

import { cliIpcCall } from "../../../ipc/cli-client.js";
import type {
  MemoryEvalRunResult,
  MemoryEvalTallyResult,
} from "../../../plugins/defaults/memory/routes/memory-eval-routes.js";
import type {
  MemoryV3BackfillSectionsResult,
  MemoryV3RebuildIndexResult,
} from "../../../plugins/defaults/memory/routes/memory-v3-routes.js";
import { registerCommand } from "../../lib/register-command.js";
import { log } from "../../logger.js";

/**
 * IPC timeout for `backfill-sections`. The one-time full-corpus section embed
 * runs every page's chunks through the embedder sequentially, which easily
 * outlasts `cliIpcCall`'s default 60s — so we give it a generous 30-minute
 * ceiling rather than report a spurious "Request timed out" while the assistant
 * keeps working.
 */
const BACKFILL_IPC_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * IPC timeout for `eval`. Embedding both corpora's sections runs through the
 * embedder and easily outlasts the default 60s, so allow the same generous
 * ceiling as the backfill.
 */
const EVAL_IPC_TIMEOUT_MS = 30 * 60 * 1000;

/** Commander accumulator for a repeatable `--exclude-conversation <id>` flag. */
function collectRepeatable(value: string, acc: string[]): string[] {
  return [...acc, value];
}

/**
 * Read the `turn` ids from a prior run's `key.json` or `packets.json` (both are
 * arrays of objects carrying a `turn` field). Used to pin `--turns-file` so a
 * re-judge measures the exact same turn set.
 */
function readTurnIdsFromFile(path: string): string[] {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(
      `--turns-file ${path} must be a JSON array (a key.json or packets.json)`,
    );
  }
  const ids = parsed
    .map((e) => (e as { turn?: unknown }).turn)
    .filter((t): t is string => typeof t === "string");
  if (ids.length === 0) {
    throw new Error(`--turns-file ${path} contained no turn ids`);
  }
  return ids;
}

/** Read and parse a JSON file, asserting it is an array. */
function readJsonArray<T>(path: string, label: string): T[] {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`--${label} ${path} must be a JSON array`);
  }
  return parsed as T[];
}

/** Render an eval-tally result as a human-readable summary block. */
function formatTally(r: MemoryEvalTallyResult): string {
  const lines = [
    `Eval gate: ${r.gate.toUpperCase()} (${r.verdict})`,
    `  turns judged:   ${r.turns} (panel ${r.panel.min}-${r.panel.max} votes/turn, mean ${r.panel.mean.toFixed(1)})`,
    `  snapshot (v2):  ${r.snapshotWins} wins, mean score ${r.meanSnapshot.toFixed(2)}`,
    `  staging (wiki): ${r.stagingWins} wins, mean score ${r.meanStaging.toFixed(2)}`,
    `  ties:           ${r.ties}`,
    `  sign-test p:    ${r.signTestP.toFixed(3)} over ${r.decided} decided turns`,
    `  confident:      ${r.confident ? "yes" : "no"}`,
  ];
  for (const note of r.notes) lines.push(`  note: ${note}`);
  return lines.join("\n");
}

export function registerMemoryV3Command(memory: Command): void {
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

      // ── eval ──────────────────────────────────────────────────────────────

      v3.command("eval")
        .description(
          "Build blinded A/B retrieval-eval packets (snapshot corpus vs staged wiki)",
        )
        .requiredOption(
          "--staging <dir>",
          "Staged v3 wiki dir (relative to the workspace, or absolute)",
        )
        .requiredOption(
          "--snapshot <dir>",
          "Read-only v2 snapshot dir (relative to the workspace, or absolute)",
        )
        .requiredOption("--out <dir>", "Output dir for packets.json + key.json")
        .option("--turns <n>", "Number of recent turns to mine", "30")
        .option("--k <n>", "Pages per memory set", "8")
        .option(
          "--seed <n>",
          "Blinding seed (reproducible A/B assignment)",
          "1",
        )
        .option(
          "--no-dense",
          "Needle-only: skip section embedding (fast, cheaper, lower fidelity)",
        )
        .option(
          "--turns-file <path>",
          "Pin the exact turns from a prior key.json/packets.json (reproducible re-judge); overrides --turns",
        )
        .option(
          "--exclude-conversation <id>",
          "Conversation id to omit from mining (repeatable; e.g. the migration's own chat)",
          collectRepeatable,
          [],
        )
        .option("--json", "Emit raw JSON instead of a formatted summary")
        .addHelpText(
          "after",
          `
Mines recent user turns, retrieves the top pages from each corpus per turn, and
writes blinded A/B packets (plus a separate unblinding key) for a blind-judge
workflow. Both corpora are read in memory — nothing in the live lanes or Qdrant
is touched. With the dense lane on (default) it embeds every section of both
corpora, which can take a while on a large corpus; use --no-dense for a fast
lexical-only pass.

To iterate on the staged wiki reproducibly, mine the turns ONCE and pin them on
every re-run with --turns-file (pointing at the first run's key.json), so the
comparison stays fixed while only the staged corpus changes. Re-runs that
re-mine drift onto a different turn set and are not comparable. Likewise, do not
compare a --no-dense run against a dense one, and check eval-meta.json's
embedding identity is the same across runs.

Examples:
  $ assistant memory v3 eval --snapshot .mv3/snapshot/concepts --staging .mv3/staging --out .mv3/eval
  $ assistant memory v3 eval --snapshot .mv3/snapshot/concepts --staging .mv3/staging --out .mv3/eval --turns-file .mv3/eval/key.json
  $ assistant memory v3 eval --snapshot .mv3/snapshot/concepts --staging .mv3/staging --out .mv3/eval --exclude-conversation <migration-conv-id>`,
        )
        .action(
          async (opts: {
            staging: string;
            snapshot: string;
            out: string;
            turns: string;
            k: string;
            seed: string;
            dense: boolean;
            turnsFile?: string;
            excludeConversation: string[];
            json?: boolean;
          }) => {
            let turnIds: string[] | undefined;
            if (opts.turnsFile !== undefined) {
              try {
                turnIds = readTurnIdsFromFile(opts.turnsFile);
              } catch (err) {
                log.error(err instanceof Error ? err.message : String(err));
                process.exitCode = 1;
                return;
              }
            }
            const result = await cliIpcCall<MemoryEvalRunResult>(
              "memory_eval_run",
              {
                body: {
                  stagingDir: opts.staging,
                  snapshotDir: opts.snapshot,
                  outDir: opts.out,
                  turns: Number(opts.turns),
                  k: Number(opts.k),
                  seed: Number(opts.seed),
                  dense: opts.dense,
                  ...(turnIds ? { turnIds } : {}),
                  ...(opts.excludeConversation.length > 0
                    ? { excludeConversationIds: opts.excludeConversation }
                    : {}),
                },
              },
              { timeoutMs: EVAL_IPC_TIMEOUT_MS },
            );
            if (!result.ok) {
              log.error(result.error ?? "Failed to build eval packets");
              process.exitCode = 1;
              return;
            }
            const payload = result.result!;
            if (opts.json === true) {
              log.info(JSON.stringify(payload, null, 2));
              return;
            }
            const emb = payload.embedding;
            const embStr = payload.dense
              ? `${emb.provider}/${emb.model}/${emb.dims ?? "?"}d`
              : "needle-only (no dense)";
            log.info(
              `Wrote ${payload.packetsWritten} packets from ${payload.turnsMined}/${payload.turnsRequested} turns ` +
                `(snapshot ${payload.snapshotPages} pages vs staged ${payload.stagingPages} pages, ` +
                `dense=${payload.dense}, embedding=${embStr}).\n` +
                `  packets: ${payload.packetsPath}\n  key:     ${payload.keyPath}\n  meta:    ${payload.metaPath}\n` +
                `  Re-judge reproducibly with: --turns-file ${payload.keyPath}`,
            );
            if (payload.turnsMined < payload.turnsRequested) {
              log.warn(
                `Only ${payload.turnsMined} of ${payload.turnsRequested} requested turns were mined ` +
                  `(pinned turns may have been deleted, or there are too few recent user turns).`,
              );
            }
          },
        );

      v3.command("eval-tally")
        .description(
          "Unblind + tally blind-judge verdicts against key.json with a noise-aware win/tie/loss verdict",
        )
        .requiredOption(
          "--verdicts <path>",
          "JSON file: array of { turn, winner, scoreA, scoreB } (one or more per turn for a panel)",
        )
        .requiredOption(
          "--key <path>",
          "key.json from `eval` — the per-turn A/B → snapshot/staging unblinding map",
        )
        .option(
          "--alpha <p>",
          "Significance threshold for the sign test (the wiki only FAILS on a significant snapshot lead)",
          "0.05",
        )
        .option("--out <path>", "Also write the full tally JSON to this path")
        .option("--json", "Emit raw JSON instead of a formatted summary")
        .addHelpText(
          "after",
          `
Joins the blind-judge verdicts to the unblinding key (A/B is shuffled PER TURN,
so the winner must be mapped turn-by-turn — a global A-vs-B count is wrong) and
applies a two-sided sign test: the wiki only FAILS when the snapshot's win lead
is statistically significant. A within-noise difference is a tie, which passes
the win-or-tie gate. Pass a judge PANEL (multiple verdicts per turn, e.g. from
re-judging under several seeds) to control single-vote noise.

Example:
  $ assistant memory v3 eval-tally --verdicts .mv3/eval/verdicts.json --key .mv3/eval/key.json`,
        )
        .action(
          async (opts: {
            verdicts: string;
            key: string;
            alpha: string;
            out?: string;
            json?: boolean;
          }) => {
            let verdicts: unknown[];
            let key: unknown[];
            try {
              verdicts = readJsonArray<unknown>(opts.verdicts, "verdicts");
              key = readJsonArray<unknown>(opts.key, "key");
            } catch (err) {
              log.error(err instanceof Error ? err.message : String(err));
              process.exitCode = 1;
              return;
            }
            const result = await cliIpcCall<MemoryEvalTallyResult>(
              "memory_eval_tally",
              { body: { verdicts, key, alpha: Number(opts.alpha) } },
            );
            if (!result.ok) {
              log.error(result.error ?? "Failed to tally verdicts");
              process.exitCode = 1;
              return;
            }
            const payload = result.result!;
            if (opts.out !== undefined) {
              writeFileSync(opts.out, JSON.stringify(payload, null, 2));
            }
            if (opts.json === true) {
              log.info(JSON.stringify(payload, null, 2));
              return;
            }
            log.info(formatTally(payload));
          },
        );
    },
  });
}
