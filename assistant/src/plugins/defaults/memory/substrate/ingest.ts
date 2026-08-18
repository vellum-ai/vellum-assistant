// SUBSTRATE (v2+v3).
/**
 * Memory substrate: deterministic batch concept-page ingest.
 *
 * Validates and writes a batch of caller-supplied concept pages (full page
 * markdown, frontmatter + body) into `memory/concepts/`. Purely mechanical:
 * no LLM calls, no network I/O. Every page is validated individually and
 * reported individually, so one malformed page never sinks the batch.
 *
 * Writes hold the consolidation lock so an ingest cannot interleave with a
 * consolidation pass rewriting the same corpus, and the collision snapshot
 * is taken under that lock so a concurrent writer's page is never silently
 * overwritten. After the lock is released, reindex follow-up jobs are
 * enqueued whenever at least one page was written (even when a later write
 * in the batch failed), so the freshly written pages become retrievable.
 */

import { join } from "node:path";

import {
  enqueueMemoryJob,
  hasPendingJobOfType,
  type MemoryJobType,
} from "../../../../persistence/jobs-store.js";
import { getLogger } from "../logging.js";
import {
  getConsolidationLockPath,
  releaseLock,
  tryAcquireLock,
} from "./consolidation-lock.js";
import { parseOriginDate } from "./page-index.js";
import { findDanglingLinks } from "./page-links.js";
import {
  isValidSlug,
  listPages,
  parsePageContent,
  validateSlug,
  writePage,
} from "./page-store.js";
import type { ConceptPage } from "./types.js";

const log = getLogger("memory-ingest");

/** One page to ingest. `content` is the full page markdown (frontmatter + body). */
export interface IngestPageInput {
  slug: string;
  content: string;
}

export interface IngestOptions {
  /** Validate and report without touching disk or the lock. */
  dryRun?: boolean;
  /** Rewrite pages whose slug already exists on disk (default: skip them). */
  overwrite?: boolean;
}

export interface IngestPageResult {
  slug: string;
  action: "written" | "skipped_exists" | "invalid";
  warnings: string[];
  error?: string;
}

export interface IngestSummary {
  results: IngestPageResult[];
  written: number;
  skipped: number;
  invalid: number;
  dryRun: boolean;
}

/** Hard cap on batch size; larger batches should be split by the caller. */
export const MAX_INGEST_PAGES_PER_CALL = 200;

/**
 * Slug prefixes owned by synthetic capability entries. Mirrors
 * `SKILL_SLUG_PREFIX` (`substrate/skill-store.ts`) and
 * `CLI_COMMAND_SLUG_PREFIX` (`substrate/cli-command-store.ts`); the literals
 * are duplicated here because importing those modules would pull the
 * embedding-backend chain into every ingest caller (the page index lazy
 * imports them for the same reason). The page index drops concept pages
 * whose slugs collide with synthetic entries, so ingesting one would
 * persist an unreachable file.
 */
const RESERVED_SLUG_PREFIXES = ["skills/", "cli-commands/"] as const;

/** Thrown when the consolidation lock is held by another writer. */
export class IngestLockedError extends Error {
  /** The lock file's holder payload (typically `<pid> <timestamp> <tag>`). */
  readonly holder: string;

  constructor(holder: string) {
    super(`memory ingest skipped: consolidation lock held by ${holder}`);
    this.name = "IngestLockedError";
    this.holder = holder;
  }
}

/**
 * Reindex fan-out after a batch that wrote at least one page, mirroring the
 * post-consolidation follow-ups: a conservative full reembed (the embedder's
 * content-hash cache makes unchanged pages effectively free) plus v3 index
 * maintenance (a no-op job on installs where v3 is not live).
 */
const REINDEX_JOB_TYPES: readonly MemoryJobType[] = [
  "memory_v2_reembed",
  "memory_v3_maintain",
];

/**
 * Validate and write a batch of concept pages under `workspaceDir`.
 *
 * Per page, in order:
 *   1. Slug shape (`validateSlug`) and in-batch uniqueness (a later duplicate
 *      of an earlier slug is `invalid`).
 *   2. Content parse via `parsePageContent`. A schema failure or a degraded
 *      parse (unterminated frontmatter fence) yields `invalid` with the parse
 *      error string: validation is per-page and loud, never a silent drop
 *      (see the `.strict()` incident documented on
 *      `ConceptPageFrontmatterSchema` for what silent dropping cost).
 *   3. Non-blocking warnings: missing `source` frontmatter, an `origin_date`
 *      that `parseOriginDate` cannot read (the same parser recency ranking
 *      uses, so a warned date is exactly one the fresh lane ignores), and a
 *      frontmatter `slug` that differs from the storage slug (links and
 *      `main:` references resolve against storage slugs, so a mismatch is
 *      almost always a staging typo).
 *   4. Collision against on-disk slugs: `skipped_exists` unless
 *      `opts.overwrite`. The snapshot backing this check is taken under the
 *      consolidation lock, so a page committed by another writer between
 *      validation and the write phase is still skipped rather than
 *      overwritten.
 *   5. One more non-blocking warning, once the on-disk snapshot exists: a
 *      `links:`, `[[wikilink]]`, or `edges:` target that is neither on disk
 *      nor a valid page in this batch. Retrieval drops such a reference, so
 *      the caller either stages the missing page or turns the reference into
 *      prose. Warned, not rejected: a page is not worth losing over one link,
 *      and a multi-batch import legitimately references a later batch.
 *      Targets under the synthetic capability prefixes are not checked (their
 *      catalog is not on disk).
 *
 * With `dryRun` the summary is returned without touching disk or the lock;
 * the dry-run collision snapshot is lock-free and therefore advisory.
 * Otherwise the consolidation lock is held across the snapshot and the
 * writes; a held lock throws {@link IngestLockedError} before anything is
 * written. After release, reindex follow-ups are enqueued when at least one
 * page was written, including when a later write in the batch threw after
 * earlier pages committed (the error still propagates).
 *
 * Throws `RangeError` when the batch exceeds {@link MAX_INGEST_PAGES_PER_CALL}.
 */
export async function ingestPages(
  workspaceDir: string,
  pages: IngestPageInput[],
  opts?: IngestOptions,
): Promise<IngestSummary> {
  if (pages.length > MAX_INGEST_PAGES_PER_CALL) {
    throw new RangeError(
      `ingest batch of ${pages.length} pages exceeds the per-call cap of ` +
        `${MAX_INGEST_PAGES_PER_CALL}; split it into smaller batches`,
    );
  }

  const dryRun = opts?.dryRun === true;
  const overwrite = opts?.overwrite === true;

  const seenSlugs = new Set<string>();
  const results: IngestPageResult[] = [];
  // Pages that passed validation. Collision classification is deferred so
  // the on-disk snapshot can be taken under the consolidation lock; each
  // entry keeps a reference to its (provisional) result in `results`.
  const pending: PendingPage[] = [];

  for (const input of pages) {
    const warnings: string[] = [];
    const invalid = (error: string): IngestPageResult => ({
      slug: input.slug,
      action: "invalid",
      warnings,
      error,
    });

    try {
      validateSlug(input.slug);
    } catch (err) {
      results.push(invalid(err instanceof Error ? err.message : String(err)));
      continue;
    }

    const reservedPrefix = RESERVED_SLUG_PREFIXES.find((prefix) =>
      input.slug.startsWith(prefix),
    );
    if (reservedPrefix !== undefined) {
      results.push(
        invalid(
          `slug prefix "${reservedPrefix}" is reserved for synthetic ` +
            `capability entries; a page written there would be dropped ` +
            `from the index (synthetic entries win slug collisions)`,
        ),
      );
      continue;
    }

    if (seenSlugs.has(input.slug)) {
      results.push(invalid(`duplicate slug within batch: ${input.slug}`));
      continue;
    }
    seenSlugs.add(input.slug);

    let page: ConceptPage;
    try {
      page = parsePageContent(input.slug, input.content);
    } catch (err) {
      results.push(invalid(err instanceof Error ? err.message : String(err)));
      continue;
    }
    if (page.parseWarning !== undefined) {
      results.push(invalid(page.parseWarning));
      continue;
    }

    if (page.frontmatter.source === undefined) {
      warnings.push(
        "missing `source` frontmatter; imported pages should carry a " +
          "provenance tag (convention `import:<provider>`)",
      );
    }
    if (
      page.frontmatter.origin_date !== undefined &&
      parseOriginDate(page.frontmatter.origin_date) === null
    ) {
      warnings.push(
        `unparseable \`origin_date\`: ${page.frontmatter.origin_date}`,
      );
    }
    if (
      page.frontmatter.slug !== undefined &&
      page.frontmatter.slug !== input.slug
    ) {
      warnings.push(
        `frontmatter \`slug\` (${page.frontmatter.slug}) differs from the ` +
          `storage slug (${input.slug}); links and \`main:\` references ` +
          `resolve against storage slugs`,
      );
    }

    // Provisional action: `classifyCollisions` downgrades it to
    // `skipped_exists` when the slug already exists on disk and overwrite
    // is off.
    const result: IngestPageResult = {
      slug: input.slug,
      action: "written",
      warnings,
    };
    results.push(result);
    pending.push({ page, result });
  }

  if (dryRun) {
    // Dry-run is advisory: the snapshot is taken without the lock, so a
    // concurrent writer can change what a later real run would do.
    const existingSlugs = new Set(await listPages(workspaceDir));
    classifyCollisions(pending, existingSlugs, overwrite);
    warnDanglingLinks(pending, existingSlugs);
    return summarize(results, dryRun);
  }

  const lockPath = getConsolidationLockPath(join(workspaceDir, "memory"));
  const holder = tryAcquireLock(lockPath, "ingest");
  if (holder !== null) {
    throw new IngestLockedError(holder);
  }
  let successfulWrites = 0;
  try {
    // The snapshot is taken under the lock so a page committed by another
    // writer after validation still classifies as a collision.
    const existingSlugs = new Set(await listPages(workspaceDir));
    const toWrite = classifyCollisions(pending, existingSlugs, overwrite);
    warnDanglingLinks(pending, existingSlugs);
    const summary = summarize(results, dryRun);

    for (const page of toWrite) {
      await writePage(workspaceDir, page);
      successfulWrites += 1;
    }

    if (summary.written > 0) {
      log.info(
        {
          written: summary.written,
          skipped: summary.skipped,
          invalid: summary.invalid,
        },
        "ingest batch written",
      );
    }
    return summary;
  } finally {
    releaseLock(lockPath);
    // Every committed page needs reindexing, including when a later write
    // in the batch threw; the follow-ups are enqueued before that error
    // propagates to the caller.
    if (successfulWrites > 0) {
      enqueueReindexFollowUps();
    }
  }
}

/** A validated page awaiting collision classification against the on-disk set. */
interface PendingPage {
  page: ConceptPage;
  result: IngestPageResult;
}

/**
 * Downgrade pending results whose slug is already on disk to `skipped_exists`
 * (unless overwriting) and return the pages left to write, in batch order.
 */
function classifyCollisions(
  pending: readonly PendingPage[],
  existingSlugs: ReadonlySet<string>,
  overwrite: boolean,
): ConceptPage[] {
  const toWrite: ConceptPage[] = [];
  for (const { page, result } of pending) {
    if (existingSlugs.has(result.slug) && !overwrite) {
      result.action = "skipped_exists";
      continue;
    }
    toWrite.push(page);
  }
  return toWrite;
}

/**
 * Append a dangling-link warning to every page about to be written whose
 * structural references name a slug that is neither on disk nor a valid page
 * in this batch. Runs after collision classification so pages the batch will
 * not write (`skipped_exists`) are not warned about.
 */
function warnDanglingLinks(
  pending: readonly PendingPage[],
  existingSlugs: ReadonlySet<string>,
): void {
  const knownSlugs = new Set(existingSlugs);
  for (const { page } of pending) {
    knownSlugs.add(page.slug);
  }
  const toWrite = pending.filter(({ result }) => result.action === "written");
  const dangling = findDanglingLinks(
    toWrite.map(({ page }) => page),
    knownSlugs,
    isValidSlug,
  ).filter(
    (d) => !RESERVED_SLUG_PREFIXES.some((prefix) => d.to.startsWith(prefix)),
  );
  if (dangling.length === 0) {
    return;
  }
  const targetsBySlug = new Map<string, string[]>();
  for (const { from, to } of dangling) {
    const targets = targetsBySlug.get(from) ?? [];
    if (!targets.includes(to)) {
      targets.push(to);
    }
    targetsBySlug.set(from, targets);
  }
  for (const { page, result } of toWrite) {
    const targets = targetsBySlug.get(page.slug);
    if (targets === undefined) {
      continue;
    }
    result.warnings.push(
      `link target${targets.length === 1 ? "" : "s"} not on disk or in ` +
        `this batch: ${targets.join(", ")}; stage the missing page or ` +
        `turn the reference into prose (retrieval drops a link whose ` +
        `target page does not exist)`,
    );
  }
}

function summarize(
  results: IngestPageResult[],
  dryRun: boolean,
): IngestSummary {
  return {
    results,
    written: results.filter((r) => r.action === "written").length,
    skipped: results.filter((r) => r.action === "skipped_exists").length,
    invalid: results.filter((r) => r.action === "invalid").length,
    dryRun,
  };
}

/**
 * Best-effort reindex fan-out. Each enqueue coalesces with an already-pending
 * job of the same type: follow-ups carry no payload and read all state at
 * execution time, so one pending row covers any number of completed batches.
 * A failed enqueue does not undo the writes; the next consolidation pass
 * performs the same fan-out.
 */
function enqueueReindexFollowUps(): void {
  for (const jobType of REINDEX_JOB_TYPES) {
    try {
      if (hasPendingJobOfType(jobType)) {
        log.debug(
          { jobType },
          "ingest: reindex follow-up already pending; skipping duplicate enqueue",
        );
        continue;
      }
      enqueueMemoryJob(jobType, {});
    } catch (err) {
      log.warn(
        { err, jobType },
        "ingest: failed to enqueue reindex follow-up; continuing",
      );
    }
  }
}
