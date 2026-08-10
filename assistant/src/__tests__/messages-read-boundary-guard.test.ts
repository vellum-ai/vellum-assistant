import { readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, test } from "bun:test";

import { Glob } from "bun";

/**
 * Ratchet over direct reads of the `messages` table outside `persistence/`.
 *
 * Every row in `messages` is conversation content in some state of
 * completeness, and each read encodes a visibility decision (completed
 * history vs. any row). `persistence/` owns that contract: named accessors in
 * `message-reads.ts` and the history readers in `conversation-crud.ts` state
 * their decision in their name; everything else should go through them. The
 * fork-corruption and phantom-turn incidents both came from direct readers
 * that silently re-decided visibility, so new direct reads are a reviewed
 * exception, not a default.
 *
 * The BASELINE lists every file outside `persistence/` that reads the table
 * directly today. Each entry has been audited and carries its visibility
 * decision as a comment at the read site. The guard fails when a file outside
 * the baseline gains a direct read (route it through an accessor, or audit it
 * and baseline it with a site comment explaining the decision in your PR),
 * and when a baseline entry goes stale (remove it, so coverage cannot rot).
 *
 * Detection is deliberately shape-based (`.from(messages)` for drizzle,
 * `FROM messages` for raw SQL): this is a ratchet against sprawl, not a
 * proof, and matching the two read shapes keeps it free of false positives
 * from unrelated identifiers.
 *
 * Regenerate after an intentional change with:
 *   UPDATE_MESSAGES_READ_BASELINE=1 bun test src/__tests__/messages-read-boundary-guard.test.ts
 * and paste the printed list here, explaining the new read in your PR.
 */

const SRC_REL = "src";
const SRC_ABS = join(process.cwd(), SRC_REL);

/** Files outside persistence/ with audited direct reads of `messages`. */
const BASELINE: readonly string[] = [
  "src/apps/app-store.ts",
  "src/daemon/credential-transcript-scrub.ts",
  "src/live-voice/live-voice-archive.ts",
  "src/monitoring/recovery/inflight-content.ts",
  "src/plugins/defaults/memory/context-search/sources/conversations.ts",
  "src/plugins/defaults/memory/graph/image-ref-utils.ts",
  "src/plugins/defaults/memory/indexer.ts",
  "src/plugins/defaults/memory/memory-retrospective-accounting.ts",
  "src/plugins/defaults/memory/substrate/sweep-job.ts",
  "src/plugins/defaults/memory/v1/graph/extraction.ts",
  "src/plugins/defaults/memory/v1/job-handlers/backfill.ts",
  "src/plugins/defaults/memory/v1/job-handlers/embedding.ts",
  "src/plugins/defaults/memory/v1/job-handlers/index-maintenance.ts",
  "src/plugins/defaults/memory/v2/harness/oracle.ts",
  "src/plugins/defaults/memory/v2/harness/replay-input.ts",
  "src/plugins/defaults/memory/v3-eval/eval-packets.ts",
  "src/plugins/defaults/memory/v3/prune.ts",
  "src/plugins/defaults/memory/v3/selection-log-store.ts",
  "src/runtime/pre-first-message-gate.ts",
  "src/runtime/routes/log-export-routes.ts",
  "src/runtime/routes/surface-conversation-resolver.ts",
  "src/telemetry/turn-events-store.ts",
  "src/telemetry/turn-trace-store.ts",
  "src/workspace/migrations/rebuild-conversation-disk-view.ts",
];

const DRIZZLE_READ = /\.from\(\s*messages\s*\)/;
const RAW_SQL_READ = /FROM\s+messages\b/;

function isExempt(relPath: string): boolean {
  const parts = relPath.split(sep);
  return (
    parts[1] === "persistence" ||
    parts.includes("__tests__") ||
    relPath.endsWith(".test.ts")
  );
}

async function scanDirectReaders(): Promise<string[]> {
  const glob = new Glob("**/*.ts");
  const found: string[] = [];
  for await (const file of glob.scan({ cwd: SRC_ABS, absolute: true })) {
    const relPath = join(SRC_REL, relative(SRC_ABS, file));
    if (isExempt(relPath)) {
      continue;
    }
    const source = readFileSync(file, "utf-8");
    if (DRIZZLE_READ.test(source) || RAW_SQL_READ.test(source)) {
      found.push(relPath);
    }
  }
  return found.sort();
}

describe("messages read boundary", () => {
  test("no new direct messages reads beyond the audited baseline", async () => {
    const found = await scanDirectReaders();

    if (process.env.UPDATE_MESSAGES_READ_BASELINE === "1") {
      console.log(JSON.stringify(found, null, 2));
    }

    const baseline = new Set(BASELINE);
    const newReaders = found.filter((file) => !baseline.has(file));
    expect(
      newReaders,
      `New direct reads of the messages table outside persistence/ (route ` +
        `through an accessor in persistence/message-reads.ts, or audit the ` +
        `read, state its visibility decision at the site, and baseline it):`,
    ).toEqual([]);

    const foundSet = new Set(found);
    const stale = BASELINE.filter((file) => !foundSet.has(file));
    expect(
      stale,
      "Stale baseline entries (the file no longer reads messages directly; remove it so coverage cannot rot):",
    ).toEqual([]);
  });
});
