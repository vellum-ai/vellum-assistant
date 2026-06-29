/**
 * OPT-IN, real-provider fan-out load & cost guard for the workflow engine.
 *
 * ─── Manual / opt-in only ───────────────────────────────────────────────────
 * This suite is SKIPPED unless `ANTHROPIC_API_KEY` is set. When a key IS
 * present it makes ~200 REAL leaf provider calls (one forced-schema
 * `workflowLeaf` call per leaf), so it is never run in CI. Run it by hand
 * when you want to validate the engine against the live provider:
 *
 *   ANTHROPIC_API_KEY=sk-... bun test src/workflows/fanout-load.test.ts
 *
 * Cost: each leaf is a tiny Haiku-class (cost-optimized) structured-output
 * call with a small per-leaf context. One full run is ~200 such calls and
 * typically costs a few US cents (well under $0.25). The assertion band below
 * caps it at $1 as a blunt runaway-cost tripwire — if a run ever approaches
 * that, something is mis-resolved (wrong model/profile) and the guard should
 * fail loudly.
 *
 * ─── What it guards against ─────────────────────────────────────────────────
 * It reproduces the shape that previously caused rate-limit collapse: many
 * concurrent leaves with non-trivial per-leaf context. The historical failure
 * mode was a `StructuredOutput` fast-fail cluster — leaves returning null /
 * zero output tokens en masse, sub-minute "completion", because the token/min
 * ceiling was blown by an over-wide fan-out. At the default
 * `maxConcurrentLeaves: 6` the engine throttles the fan-out, so the collapse
 * must NOT recur. This test asserts that: every leaf returns real non-zero
 * output, the run completes (not `cap_exceeded` / `failed`), wall-clock lands
 * in a generous band, and summed cost stays within a sane envelope.
 */

import { describe, expect, test } from "bun:test";

import { z } from "zod";

import { getConfig } from "../config/loader.js";
import type { TrustContext } from "../daemon/trust-context.js";
import { initializeDb } from "../persistence/db-init.js";
import { listUsageEvents } from "../persistence/llm-usage-store.js";
import { resolveCapabilities } from "./capabilities.js";
import { executeWorkflow } from "./engine.js";
import * as journalStore from "./journal-store.js";
import { runLeaf } from "./leaf-runner.js";

const apiKey = process.env.ANTHROPIC_API_KEY;

// Number of concurrent leaves the historical collapse fanned out over; the
// guard runs the same shape at the engine's default concurrency.
const LEAF_COUNT = 200;

// Generous wall-clock ceiling. At concurrency 6 with ~200 short leaves this
// is well under a couple minutes in practice; the band only fails on a true
// stall, not on normal provider jitter.
const MAX_WALL_CLOCK_MS = 8 * 60_000;

// Runaway-cost tripwire (see header). A healthy run is a few cents.
const MAX_COST_USD = 1;

const TRUST: TrustContext = { sourceChannel: "vellum", trustClass: "guardian" };

describe.skipIf(!apiKey)(
  "Workflow fan-out load & cost guard — real provider",
  () => {
    test(
      "200-leaf fan-out at default concurrency does not rate-limit-collapse",
      async () => {
        await initializeDb();

        // Non-trivial per-leaf context mirrors the real fan-out shape: each
        // leaf judges a distinct synthetic record, not a one-token prompt.
        const items = Array.from({ length: LEAF_COUNT }, (_, i) => ({
          id: i,
          subject: `synthetic-record-${i}`,
          body:
            `Incident report #${i}. A background job processed batch ${i % 7} ` +
            `with status code ${200 + (i % 5)} and emitted ${3 + (i % 11)} ` +
            `warnings about resource contention on shard ${i % 13}. The ` +
            `operator noted latency drift of ${(i % 9) * 4}ms over the window.`,
        }));

        // Schema-forced judgement per leaf: a small structured output that
        // forces a real `workflowLeaf` provider call and a non-empty result.
        const judgement = z.object({
          severity: z.enum(["low", "medium", "high"]),
          summary: z.string(),
        });

        const scriptSource = `
export const meta = {
  name: "fanout-load-guard",
  description: "200-leaf real-provider fan-out load & cost guard",
};

const results = map(args.items, (item) =>
  leaf(
    "Classify the severity of this incident and summarize it in one short " +
      "sentence.\\n\\n" +
      "Subject: " + item.subject + "\\n" +
      "Body: " + item.body,
    { schema: args.schema, label: "judge-" + item.id },
  ),
);

return results;
`;

        const runId = `fanout-load-${Date.now()}`;
        const startedAt = Date.now();

        const result = await executeWorkflow({
          runId,
          scriptSource,
          args: { items, schema: judgement },
          capabilities: resolveCapabilities({
            tools: [],
            hostFunctions: [],
            persona: false,
          }),
          config: getConfig().workflows,
          journal: journalStore,
          leafRunner: runLeaf,
          trustContext: TRUST,
        });

        const wallClockMs = Date.now() - startedAt;

        // The engine must have throttled, not collapsed: the run completes.
        expect(result.status).toBe("completed");
        expect(result.agentsSpawned).toBe(LEAF_COUNT);

        // No `StructuredOutput` fast-fail cluster: every leaf returns a real,
        // schema-valid, non-null result (the collapse manifested as all-null).
        const leafResults = result.result as Array<z.infer<
          typeof judgement
        > | null>;
        expect(Array.isArray(leafResults)).toBe(true);
        expect(leafResults).toHaveLength(LEAF_COUNT);
        const nulls = leafResults.filter((r) => r == null);
        expect(nulls).toHaveLength(0);
        const invalid = leafResults.filter(
          (r) => !judgement.safeParse(r).success,
        );
        expect(invalid).toHaveLength(0);

        // Real, non-zero output tokens in aggregate (the collapse zeroed these
        // out as leaves fast-failed before producing any tokens).
        expect(result.outputTokens).toBeGreaterThan(0);
        expect(result.inputTokens).toBeGreaterThan(0);

        // Wall-clock within a generous band: not a sub-second mass-fail, and
        // not an indefinite stall.
        expect(wallClockMs).toBeLessThan(MAX_WALL_CLOCK_MS);

        // Summed cost over this run's `workflowLeaf` usage events stays within
        // a sane envelope. Filter by call site + the run's start time so we
        // only sum events this run produced (the table is shared).
        const events = listUsageEvents({ limit: 10_000 });
        const runCostUsd = events
          .filter(
            (e) => e.callSite === "workflowLeaf" && e.createdAt >= startedAt,
          )
          .reduce((sum, e) => sum + (e.estimatedCostUsd ?? 0), 0);
        expect(runCostUsd).toBeGreaterThan(0);
        expect(runCostUsd).toBeLessThan(MAX_COST_USD);
      },
      MAX_WALL_CLOCK_MS + 60_000,
    );
  },
);
