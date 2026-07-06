/**
 * PKB filing and compaction as background-job handlers.
 *
 * Both jobs run as the assistant: a templated maintenance prompt is handed to
 * `runBackgroundJob()`, which bootstraps a background conversation and runs a
 * full agent turn. They are scheduled by the jobs-worker's maintenance loop
 * (`maybeEnqueueGraphMaintenanceJobs`) on durable checkpoints — v1-only, since
 * memory v2's consolidation job owns periodic background memory processing —
 * and dispatched through the same worker as every other memory job, which also
 * applies the disk-pressure gate centrally.
 *
 * Filing and compaction both write the PKB tree, so the scheduler enqueues at
 * most one of the two at a time (see the mutual-exclusion check there). The
 * `filing/run-now` route enqueues a `pkb_filing` job with `{ force: true }`,
 * which bypasses the handler's empty-buffer skip.
 */

import type { LLMCallSite } from "@vellumai/plugin-api";

import type { MemoryJob } from "../../../persistence/jobs-store.js";
import { runBackgroundJob } from "../../../runtime/background-job-runner.js";
import { getLogger } from "../../../util/logger.js";
import { hasPkbBufferContent } from "./pkb-schedule.js";

const log = getLogger("filing-jobs");

const FILING_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes

const FILING_PROMPT_TEMPLATE = `You are running a periodic knowledge base filing job. This is a background maintenance task focused on the buffer.

Read \`pkb/buffer.md\`. For each item in the buffer:
1. Determine which topic file(s) it belongs in. Check \`pkb/INDEX.md\` to see what topic files exist.
2. Read the target topic file(s), then integrate the new fact.
3. If the fact is important enough to always be in context, add it to \`pkb/essentials.md\` instead.
4. If the fact is a commitment, follow-up, or active project, add it to \`pkb/threads.md\`.
5. If no existing topic file fits, create a new one and update \`pkb/INDEX.md\`.

After all items are filed, clear the processed items from \`pkb/buffer.md\` (leave the file empty, don't delete it).

Do not audit, restructure, or split topic files in this job. File-size discipline and PKB hygiene are owned by the daily compaction job — focus only on draining the buffer here.`;

const COMPACTION_PROMPT_TEMPLATE = `You are running the daily PKB compaction job. This is the only place file-size discipline gets enforced — the periodic filing job intentionally skips it.

## Step 1 — Audit

List every \`.md\` file under \`pkb/\` (recursively, excluding \`pkb/archive/\`) that exceeds its budget. Use \`wc -c\` (or equivalent) to measure size in bytes.

Default budgets by file class:
- Autoloaded files (always in your context — \`pkb/INDEX.md\`, \`pkb/essentials.md\`, \`pkb/threads.md\`, \`pkb/buffer.md\`, plus anything in \`pkb/_autoinject.md\`): ≤ 15K chars each. These cost a tax on every conversation, so keep them lean.
- All other topic files: ≤ 8K chars (~1.5K tokens). This is the default bar.

If your knowledge base has files that legitimately need higher budgets (e.g. a phrasebook, a catalog, a long-form narrative bounded by a single event) or files that should be exempt from size pressure entirely, document those exceptions in \`pkb/INDEX.md\` and honor what you've written there. Don't flag a file you've already decided to grandfather.

## Step 2 — Fix the worst

Pick the single most-over-budget file from Step 1 and either split or compress it this run. One file per run is enough — the cadence is daily. Splitting strategies:
- Move sections into a sibling subdirectory keyed off the parent filename, then rewrite the original as an index pointing at the splits.
- For phrasebook-style files, replace extended analysis with one-line entries that point at the matching detail file.
- For autoloaded files, demote on-demand-only sections into topic files and link them from \`INDEX.md\`.

If no file is over budget, skip Step 2 and report that everything is within limits.

## Step 3 — Sweep

- Promote anything in \`pkb/essentials.md\` that's no longer essential to its topic file.
- Demote anything important enough to always be in context up into \`pkb/essentials.md\`.
- Remove completed or stale threads from \`pkb/threads.md\`.
- Consolidate any duplicate facts you spot during the audit.

## Step 4 — Update INDEX

If the disk shape changed (files split, files moved, files created, files removed), update \`pkb/INDEX.md\` so it reflects reality.

This is your knowledge base — keep it sharp.`;

/**
 * `pkb_filing` job handler — drain `pkb/buffer.md` into the PKB topic files.
 * Skips (without an LLM run) when the buffer is empty, unless the job was
 * enqueued with `{ force: true }` (the `filing/run-now` route).
 */
export async function pkbFilingJob(job: MemoryJob): Promise<void> {
  const force = (job.payload as { force?: boolean })?.force === true;
  if (!force && !hasPkbBufferContent()) {
    log.debug("Buffer is empty, skipping filing");
    return;
  }
  await executeBackgroundJob({
    jobName: "filing",
    systemHint: "Knowledge base filing",
    prompt: FILING_PROMPT_TEMPLATE,
    callSite: "filingAgent",
  });
}

/** `pkb_compaction` job handler — daily PKB organization/file-size pass. */
export async function pkbCompactionJob(): Promise<void> {
  await executeBackgroundJob({
    jobName: "compaction",
    systemHint: "Knowledge base compaction",
    prompt: COMPACTION_PROMPT_TEMPLATE,
    callSite: "compactionAgent",
  });
}

async function executeBackgroundJob(opts: {
  jobName: string;
  systemHint: string;
  prompt: string;
  callSite: LLMCallSite;
}): Promise<void> {
  log.info({ jobName: opts.jobName }, "Running background job");

  const result = await runBackgroundJob({
    jobName: opts.jobName,
    source: "filing",
    systemHint: opts.systemHint,
    prompt: opts.prompt,
    trustContext: {
      sourceChannel: "vellum",
      trustClass: "guardian",
    },
    callSite: opts.callSite,
    timeoutMs: FILING_TIMEOUT_MS,
    origin: "filing",
  });

  if (result.ok) {
    log.info(
      { conversationId: result.conversationId, jobName: opts.jobName },
      "Background job completed",
    );
  }
}
