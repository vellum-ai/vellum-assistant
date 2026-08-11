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
 * their decision in their name; everything else should go through them. A
 * direct reader that re-decides visibility on its own is how the contract
 * fails silently, so a new direct read is a reviewed exception, not a
 * default.
 *
 * The BASELINE lists every file outside `persistence/` that reads the table
 * directly today. Each entry has been audited and carries its visibility
 * decision as a comment at the read site. The guard fails when a file outside
 * the baseline gains a direct read (route it through an accessor, or audit it
 * and baseline it with a site comment explaining the decision in your PR),
 * and when a baseline entry goes stale (remove it, so coverage cannot rot).
 *
 * Detection is deliberately shape-based (from/join of `messages` in drizzle
 * builders, `FROM messages` / `JOIN messages` in raw SQL): this is a ratchet
 * against sprawl, not a proof, and matching the read shapes keeps it free of
 * false positives from unrelated identifiers.
 *
 * Regenerate after an intentional change with:
 *   UPDATE_MESSAGES_READ_BASELINE=1 bun test src/__tests__/messages-read-boundary-guard.test.ts
 * and paste the printed list here, explaining the new read in your PR.
 */

const SRC_REL = "src";
const SRC_ABS = join(process.cwd(), SRC_REL);

/**
 * Audited direct readers outside persistence/, as file -> count of matching
 * read sites. Counts, not just filenames: a new read added inside an
 * already-baselined file must fail the ratchet too, since each site carries
 * its own visibility decision. A same-file refactor that replaces one read
 * with another at equal count passes; that is accepted ratchet granularity
 * (the diff still shows the site to its reviewer).
 */
const BASELINE: Readonly<Record<string, number>> = {
  "src/apps/app-store.ts": 1,
  "src/daemon/credential-transcript-scrub.ts": 1,
  "src/live-voice/live-voice-archive.ts": 1,
  "src/monitoring/recovery/inflight-content.ts": 2,
  "src/plugins/defaults/memory/context-search/sources/conversations.ts": 1,
  "src/plugins/defaults/memory/graph/image-ref-utils.ts": 1,
  "src/plugins/defaults/memory/indexer.ts": 2,
  "src/plugins/defaults/memory/memory-retrospective-accounting.ts": 4,
  "src/plugins/defaults/memory/substrate/sweep-job.ts": 1,
  "src/plugins/defaults/memory/v1/graph/extraction.ts": 3,
  "src/plugins/defaults/memory/v1/job-handlers/backfill.ts": 1,
  "src/plugins/defaults/memory/v1/job-handlers/embedding.ts": 1,
  "src/plugins/defaults/memory/v1/job-handlers/index-maintenance.ts": 1,
  "src/plugins/defaults/memory/v2/harness/oracle.ts": 1,
  "src/plugins/defaults/memory/v2/harness/replay-input.ts": 1,
  "src/plugins/defaults/memory/v3-eval/eval-packets.ts": 2,
  "src/plugins/defaults/memory/v3/prune.ts": 1,
  "src/plugins/defaults/memory/v3/selection-log-store.ts": 1,
  "src/runtime/pre-first-message-gate.ts": 1,
  "src/runtime/routes/log-export-routes.ts": 1,
  "src/runtime/routes/surface-conversation-resolver.ts": 2,
  "src/telemetry/turn-events-store.ts": 2,
  "src/telemetry/turn-trace-store.ts": 2,
  "src/workspace/migrations/rebuild-conversation-disk-view.ts": 1,
};

const DRIZZLE_READ =
  /\.(?:from|innerJoin|leftJoin|rightJoin|fullJoin)\(\s*messages\s*[,)]/g;
const RAW_SQL_READ = /(?:FROM|JOIN)\s+messages\b/g;

function isExempt(relPath: string): boolean {
  const parts = relPath.split(sep);
  return (
    parts[1] === "persistence" ||
    parts.includes("__tests__") ||
    relPath.endsWith(".test.ts")
  );
}

async function scanDirectReaders(): Promise<Map<string, number>> {
  const glob = new Glob("**/*.ts");
  const found = new Map<string, number>();
  for await (const file of glob.scan({ cwd: SRC_ABS, absolute: true })) {
    const relPath = join(SRC_REL, relative(SRC_ABS, file));
    if (isExempt(relPath)) {
      continue;
    }
    const source = readFileSync(file, "utf-8");
    const count =
      [...source.matchAll(DRIZZLE_READ)].length +
      [...source.matchAll(RAW_SQL_READ)].length;
    if (count > 0) {
      found.set(relPath, count);
    }
  }
  return found;
}

describe("messages read boundary", () => {
  test("no new direct messages reads beyond the audited baseline", async () => {
    const found = await scanDirectReaders();

    if (process.env.UPDATE_MESSAGES_READ_BASELINE === "1") {
      console.log(
        JSON.stringify(Object.fromEntries([...found].sort()), null, 2),
      );
    }

    const grown = [...found]
      .filter(([file, count]) => count > (BASELINE[file] ?? 0))
      .map(([file, count]) => `${file}: ${BASELINE[file] ?? 0} -> ${count}`);
    expect(
      grown,
      `New direct reads of the messages table outside persistence/ (route ` +
        `through an accessor in persistence/message-reads.ts, or audit the ` +
        `read, state its visibility decision at the site, and baseline it):`,
    ).toEqual([]);

    const shrunk = Object.entries(BASELINE)
      .filter(([file, count]) => (found.get(file) ?? 0) < count)
      .map(([file, count]) => `${file}: ${count} -> ${found.get(file) ?? 0}`);
    expect(
      shrunk,
      "Stale baseline entries (fewer direct reads than baselined; ratchet the count down so coverage cannot rot):",
    ).toEqual([]);
  });
});
