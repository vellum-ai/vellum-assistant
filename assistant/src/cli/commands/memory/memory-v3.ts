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
import { subcommand } from "../../lib/cli-command-help.js";
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
  const v3 = subcommand(memory, "v3");

  // ── rebuild-index ─────────────────────────────────────────────────────

  subcommand(v3, "rebuild-index").action(async () => {
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

  subcommand(v3, "backfill-sections").action(
    async (opts: { json?: boolean }) => {
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
    },
  );

  // ── eval ──────────────────────────────────────────────────────────────

  // The repeatable `--exclude-conversation` option (accumulator parser +
  // array default) and the `--json` option that must follow it in help order
  // are not expressible in the declarative help contract, so they stay
  // imperative.
  subcommand(v3, "eval")
    .option(
      "--exclude-conversation <id>",
      "Conversation id to omit from mining (repeatable; e.g. the migration's own chat)",
      collectRepeatable,
      [],
    )
    .option("--json", "Emit raw JSON instead of a formatted summary")
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

  // ── eval-tally ────────────────────────────────────────────────────────

  subcommand(v3, "eval-tally").action(
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
}
