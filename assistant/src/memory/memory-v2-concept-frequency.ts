import type { MemoryV2ConceptRowRecord } from "./memory-v2-activation-log-store.js";
import { rawAll, rawGet } from "./raw-query.js";
import { listPages } from "./v2/page-store.js";

type ConceptStatus = MemoryV2ConceptRowRecord["status"];

export type ConceptFrequencyCounts = Record<ConceptStatus, number>;

export interface ConceptFrequencyRow {
  slug: string;
  counts: ConceptFrequencyCounts;
  totalEvaluations: number;
  lastInjectedAt: number | null;
  /** Whether the slug currently has a markdown page on disk. */
  onDisk: boolean;
}

export interface ConceptFrequencyResponse {
  filters: {
    conversationId: string | null;
    sinceMs: number | null;
  };
  totals: {
    /** Activation log rows scanned (turns of evaluation in the window). */
    logCount: number;
    /** Sum of per-row concept evaluations across all log rows in the window. */
    conceptOccurrences: number;
  };
  /** Per-slug aggregates, sorted by `totalEvaluations` desc, then slug asc. */
  concepts: ConceptFrequencyRow[];
  /**
   * Slugs present on disk that never appeared in any activation log row in
   * the window — i.e. retrieval never even scored them as a candidate.
   */
  neverEvaluatedSlugs: string[];
}

export interface GetConceptFrequencyFilters {
  conversationId?: string;
  sinceMs?: number;
}

interface AggRow {
  slug: string | null;
  status: ConceptStatus | string | null;
  count: number;
  last_seen: number;
}

const ZERO_COUNTS: ConceptFrequencyCounts = {
  injected: 0,
  in_context: 0,
  not_injected: 0,
  page_missing: 0,
};

interface CountRow {
  count: number;
}

export async function getConceptFrequencySummary(
  workspaceDir: string,
  filters: GetConceptFrequencyFilters = {},
): Promise<ConceptFrequencyResponse> {
  const conversationId = filters.conversationId ?? null;
  const sinceMs = filters.sinceMs ?? null;

  // Kick off the on-disk page walk in parallel with the (synchronous) SQL
  // queries below — listPages does fs.readdir, rawAll/rawGet are sync.
  const onDiskSlugsPromise = listPages(workspaceDir);

  const aggRows = rawAll<AggRow>(
    `SELECT
       json_extract(c.value, '$.slug')   AS slug,
       json_extract(c.value, '$.status') AS status,
       COUNT(*)                          AS count,
       MAX(l.created_at)                 AS last_seen
     FROM memory_v2_activation_logs l, json_each(l.concepts_json) c
     WHERE (? IS NULL OR l.conversation_id = ?)
       AND (? IS NULL OR l.created_at >= ?)
     GROUP BY slug, status`,
    conversationId,
    conversationId,
    sinceMs,
    sinceMs,
  );

  const logCountRow = rawGet<CountRow>(
    `SELECT COUNT(*) AS count
       FROM memory_v2_activation_logs
       WHERE (? IS NULL OR conversation_id = ?)
         AND (? IS NULL OR created_at >= ?)`,
    conversationId,
    conversationId,
    sinceMs,
    sinceMs,
  );

  const bySlug = new Map<string, ConceptFrequencyRow>();
  let conceptOccurrences = 0;

  for (const row of aggRows) {
    if (!row.slug) continue;
    let entry = bySlug.get(row.slug);
    if (!entry) {
      entry = {
        slug: row.slug,
        counts: { ...ZERO_COUNTS },
        totalEvaluations: 0,
        lastInjectedAt: null,
        onDisk: false,
      };
      bySlug.set(row.slug, entry);
    }

    switch (row.status) {
      case "injected":
        entry.counts.injected += row.count;
        entry.lastInjectedAt =
          entry.lastInjectedAt === null
            ? row.last_seen
            : Math.max(entry.lastInjectedAt, row.last_seen);
        break;
      case "in_context":
        entry.counts.in_context += row.count;
        break;
      case "not_injected":
        entry.counts.not_injected += row.count;
        break;
      case "page_missing":
        entry.counts.page_missing += row.count;
        break;
      default:
        // Forward-compat: unknown status values are ignored, not summed into
        // totalEvaluations. The activation pipeline produces a closed enum.
        continue;
    }
    entry.totalEvaluations += row.count;
    conceptOccurrences += row.count;
  }

  const onDiskSlugs = new Set(await onDiskSlugsPromise);
  for (const entry of bySlug.values()) {
    entry.onDisk = onDiskSlugs.has(entry.slug);
  }

  const neverEvaluatedSlugs: string[] = [];
  for (const slug of onDiskSlugs) {
    if (!bySlug.has(slug)) neverEvaluatedSlugs.push(slug);
  }
  neverEvaluatedSlugs.sort();

  const concepts = [...bySlug.values()].sort((a, b) => {
    if (b.totalEvaluations !== a.totalEvaluations) {
      return b.totalEvaluations - a.totalEvaluations;
    }
    return a.slug.localeCompare(b.slug);
  });

  return {
    filters: { conversationId, sinceMs },
    totals: {
      logCount: logCountRow?.count ?? 0,
      conceptOccurrences,
    },
    concepts,
    neverEvaluatedSlugs,
  };
}
