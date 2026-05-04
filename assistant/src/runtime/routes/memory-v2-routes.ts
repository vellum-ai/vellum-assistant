/**
 * Memory v2 route definitions — backfill + validate + reembed-skills.
 *
 * Migrated from `ipc/routes/memory-v2-backfill.ts` and
 * `ipc/routes/memory-v2-validate.ts` into the shared ROUTES array.
 */
import { z } from "zod";

import { isAssistantFeatureFlagEnabled } from "../../config/assistant-feature-flags.js";
import { loadConfig } from "../../config/loader.js";
import {
  applyCorrectionIfCalibrated,
  explainedVarianceRatio,
  fitAnisotropyCalibration,
  saveCalibration,
} from "../../memory/anisotropy.js";
import {
  embedWithBackend,
  selectEmbeddingBackend,
} from "../../memory/embedding-backend.js";
import {
  enqueueMemoryJob,
  type MemoryJobType,
} from "../../memory/jobs-store.js";
import {
  getEdgeIndex,
  totalEdgeCount,
  validateEdgeTargets,
} from "../../memory/v2/edge-index.js";
import {
  listPages,
  readPage,
  renderPageContent,
} from "../../memory/v2/page-store.js";
import {
  hybridQueryConceptPages,
  sampleConceptPageDenseVectors,
} from "../../memory/v2/qdrant.js";
import { seedV2SkillEntries } from "../../memory/v2/skill-store.js";
import {
  generateBm25QueryEmbedding,
  getConceptPageCorpusStats,
  rebuildConceptPageCorpusStats,
} from "../../memory/v2/sparse-bm25.js";
import { getWorkspaceDir } from "../../util/platform.js";
import { RouteError } from "./errors.js";
import type { RouteDefinition } from "./types.js";
import type { RouteHandlerArgs } from "./types.js";

// ── Backfill ────────────────────────────────────────────────────────────

const MemoryV2BackfillParams = z
  .object({
    op: z.enum(["migrate", "reembed", "activation-recompute"]),
    force: z.boolean().optional(),
  })
  .strict();

export type MemoryV2BackfillOp = z.infer<typeof MemoryV2BackfillParams>["op"];

export type MemoryV2BackfillResult = {
  jobId: string;
};

const OP_TO_JOB_TYPE: Record<MemoryV2BackfillOp, MemoryJobType> = {
  migrate: "memory_v2_migrate",
  reembed: "memory_v2_reembed",
  "activation-recompute": "memory_v2_activation_recompute",
};

async function handleBackfill({
  body = {},
}: RouteHandlerArgs): Promise<MemoryV2BackfillResult> {
  const { op, force } = MemoryV2BackfillParams.parse(body);
  const payload: Record<string, unknown> =
    op === "migrate" && force === true ? { force: true } : {};
  const jobId = enqueueMemoryJob(OP_TO_JOB_TYPE[op], payload);
  return { jobId };
}

// ── Validate ────────────────────────────────────────────────────────────

const MemoryV2ValidateParams = z.object({}).strict();

type MissingEdgeEndpoint = { from: string; to: string };
type OversizedPage = { slug: string; chars: number };
type ParseFailure = { slug: string; error: string };

export type MemoryV2ValidateResult = {
  pageCount: number;
  edgeCount: number;
  missingEdgeEndpoints: MissingEdgeEndpoint[];
  oversizedPages: OversizedPage[];
  parseFailures: ParseFailure[];
};

async function handleValidate({
  body = {},
}: RouteHandlerArgs): Promise<MemoryV2ValidateResult> {
  MemoryV2ValidateParams.parse(body);

  const workspaceDir = getWorkspaceDir();
  const maxPageChars = loadConfig().memory.v2.max_page_chars;

  const slugs = await listPages(workspaceDir);
  const knownSlugs = new Set<string>();
  const oversizedPages: OversizedPage[] = [];
  const parseFailures: ParseFailure[] = [];

  for (const slug of slugs) {
    try {
      const page = await readPage(workspaceDir, slug);
      if (!page) continue;
      knownSlugs.add(slug);
      const chars = Buffer.byteLength(page.body, "utf8");
      if (chars > maxPageChars) {
        oversizedPages.push({ slug, chars });
      }
    } catch (err) {
      parseFailures.push({
        slug,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const edgeIndex = await getEdgeIndex(workspaceDir);
  const { missing } = validateEdgeTargets(edgeIndex, knownSlugs);

  return {
    pageCount: knownSlugs.size,
    edgeCount: totalEdgeCount(edgeIndex),
    missingEdgeEndpoints: missing,
    oversizedPages,
    parseFailures,
  };
}

// ── Get concept page ────────────────────────────────────────────────────

const MemoryV2GetConceptPageParams = z
  .object({
    slug: z.string().min(1),
  })
  .strict();

export type MemoryV2GetConceptPageResult = {
  slug: string;
  /** Frontmatter + body, as produced by `renderPageContent`. */
  rendered: string;
};

async function handleGetConceptPage({
  body = {},
}: RouteHandlerArgs): Promise<MemoryV2GetConceptPageResult> {
  const { slug } = MemoryV2GetConceptPageParams.parse(body);
  const workspaceDir = getWorkspaceDir();
  let page;
  try {
    page = await readPage(workspaceDir, slug);
  } catch (err) {
    throw new RouteError(
      `Failed to read concept page '${slug}': ${err instanceof Error ? err.message : String(err)}`,
      "MEMORY_V2_PAGE_READ_FAILED",
      400,
    );
  }
  if (!page) {
    throw new RouteError(
      `Concept page '${slug}' not found on disk`,
      "MEMORY_V2_PAGE_NOT_FOUND",
      404,
    );
  }
  return { slug, rendered: renderPageContent(page) };
}

// ── Rebuild BM25 corpus stats ───────────────────────────────────────────

const MemoryV2RebuildCorpusStatsParams = z.object({}).strict();

export interface MemoryV2RebuildCorpusStatsResult {
  totalDocs: number;
  avgDl: number;
  /** Number of distinct hashed-token buckets that received any DF count. */
  vocabularyBuckets: number;
}

async function handleRebuildCorpusStats({
  body = {},
}: RouteHandlerArgs): Promise<MemoryV2RebuildCorpusStatsResult> {
  MemoryV2RebuildCorpusStatsParams.parse(body);
  const workspaceDir = getWorkspaceDir();
  await rebuildConceptPageCorpusStats(workspaceDir);
  const stats = getConceptPageCorpusStats();
  if (!stats) {
    // The rebuild always swaps in a non-null table on success, so a missing
    // value here means an unexpected reset between rebuild and read.
    throw new RouteError(
      "Corpus stats rebuild completed but no table is loaded",
      "MEMORY_V2_CORPUS_STATS_MISSING",
      500,
    );
  }
  return {
    totalDocs: stats.totalDocs,
    avgDl: stats.avgDl,
    vocabularyBuckets: stats.df.size,
  };
}

// ── Reembed skills ──────────────────────────────────────────────────────

const MemoryV2ReembedSkillsParams = z.object({}).strict();

export type MemoryV2ReembedSkillsResult = {
  success: true;
};

async function handleReembedSkills({
  body = {},
}: RouteHandlerArgs): Promise<MemoryV2ReembedSkillsResult> {
  MemoryV2ReembedSkillsParams.parse(body);

  // Gate the route on both the feature flag and the per-workspace config
  // toggle so the v2 skill collection never gets re-seeded against a
  // workspace whose v2 subsystem is intentionally off.
  const config = loadConfig();
  if (
    !isAssistantFeatureFlagEnabled("memory-v2-enabled", config) ||
    !config.memory.v2.enabled
  ) {
    throw new RouteError(
      "Memory v2 is not enabled — flip both the memory-v2-enabled feature flag and memory.v2.enabled to use this command.",
      "MEMORY_V2_DISABLED",
      409,
    );
  }

  // Unlike the queued backfill jobs above, this is a CLI-driven sync
  // request: the operator wants the cache replaced before the next prompt
  // assembly, so we await the seed inline rather than enqueueing it.
  await seedV2SkillEntries();

  return { success: true };
}

// ── Explain similarity ──────────────────────────────────────────────────

const MemoryV2ExplainSimilarityParams = z
  .object({
    userText: z.string().min(1),
    assistantText: z.string().optional(),
    nowText: z.string().optional(),
    top: z.number().int().min(1).default(25),
  })
  .strict();

export interface MemoryV2ExplainSimilarityRow {
  slug: string;
  /** Raw dense cosine score, or null when the slug missed the dense channel. */
  denseScore: number | null;
  /** Raw sparse score (Qdrant scale), or null when the slug missed sparse. */
  sparseRaw: number | null;
  /** Sparse score divided by the per-batch max, in [0, 1]. */
  sparseNorm: number | null;
  /** `clamp01(dense_weight·dense + sparse_weight·sparseNorm)` — the simBatch fused value. */
  fused: number;
}

export interface MemoryV2ExplainSimilarityStats {
  count: number;
  min: number;
  max: number;
  mean: number;
  stddev: number;
}

export interface MemoryV2ExplainSimilarityChannel {
  channel: "user" | "assistant" | "now";
  textPreview: string;
  maxSparse: number;
  rows: MemoryV2ExplainSimilarityRow[];
  stats: {
    dense: MemoryV2ExplainSimilarityStats;
    sparseRaw: MemoryV2ExplainSimilarityStats;
    sparseNorm: MemoryV2ExplainSimilarityStats;
    fused: MemoryV2ExplainSimilarityStats;
  };
}

export interface MemoryV2ExplainSimilarityResult {
  config: {
    dense_weight: number;
    sparse_weight: number;
  };
  channels: MemoryV2ExplainSimilarityChannel[];
}

function summarizeStats(values: number[]): MemoryV2ExplainSimilarityStats {
  if (values.length === 0) {
    return { count: 0, min: 0, max: 0, mean: 0, stddev: 0 };
  }
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
  }
  const mean = sum / values.length;
  let sqDiff = 0;
  for (const v of values) sqDiff += (v - mean) * (v - mean);
  const stddev = Math.sqrt(sqDiff / values.length);
  return { count: values.length, min, max, mean, stddev };
}

async function scoreChannel(
  channel: "user" | "assistant" | "now",
  text: string,
  top: number,
  denseWeight: number,
  sparseWeight: number,
  config: ReturnType<typeof loadConfig>,
): Promise<MemoryV2ExplainSimilarityChannel> {
  const denseResult = await embedWithBackend(config, [text]);
  const denseVec = await applyCorrectionIfCalibrated(
    denseResult.vectors[0],
    denseResult.provider,
    denseResult.model,
  );
  const sparseVec = generateBm25QueryEmbedding(text);

  const hits = await hybridQueryConceptPages(denseVec, sparseVec, top);

  let maxSparse = 0;
  for (const hit of hits) {
    if (hit.sparseScore !== undefined && hit.sparseScore > maxSparse) {
      maxSparse = hit.sparseScore;
    }
  }

  const rows: MemoryV2ExplainSimilarityRow[] = hits.map((hit) => {
    const dense = hit.denseScore ?? 0;
    const sparseNorm =
      hit.sparseScore !== undefined && maxSparse > 0
        ? hit.sparseScore / maxSparse
        : 0;
    const fusedRaw = denseWeight * dense + sparseWeight * sparseNorm;
    const fused = Math.max(0, Math.min(1, fusedRaw));
    return {
      slug: hit.slug,
      denseScore: hit.denseScore ?? null,
      sparseRaw: hit.sparseScore ?? null,
      sparseNorm: hit.sparseScore !== undefined ? sparseNorm : null,
      fused,
    };
  });

  rows.sort((a, b) => b.fused - a.fused);

  const denseValues: number[] = [];
  const sparseRawValues: number[] = [];
  const sparseNormValues: number[] = [];
  const fusedValues: number[] = [];
  for (const row of rows) {
    if (row.denseScore !== null) denseValues.push(row.denseScore);
    if (row.sparseRaw !== null) sparseRawValues.push(row.sparseRaw);
    if (row.sparseNorm !== null) sparseNormValues.push(row.sparseNorm);
    fusedValues.push(row.fused);
  }

  return {
    channel,
    textPreview: text.length > 120 ? `${text.slice(0, 120)}…` : text,
    maxSparse,
    rows,
    stats: {
      dense: summarizeStats(denseValues),
      sparseRaw: summarizeStats(sparseRawValues),
      sparseNorm: summarizeStats(sparseNormValues),
      fused: summarizeStats(fusedValues),
    },
  };
}

async function handleExplainSimilarity({
  body = {},
}: RouteHandlerArgs): Promise<MemoryV2ExplainSimilarityResult> {
  const params = MemoryV2ExplainSimilarityParams.parse(body);
  const config = loadConfig();
  const { dense_weight: denseWeight, sparse_weight: sparseWeight } =
    config.memory.v2;

  const channels: MemoryV2ExplainSimilarityChannel[] = [];
  channels.push(
    await scoreChannel(
      "user",
      params.userText,
      params.top,
      denseWeight,
      sparseWeight,
      config,
    ),
  );
  if (params.assistantText && params.assistantText.length > 0) {
    channels.push(
      await scoreChannel(
        "assistant",
        params.assistantText,
        params.top,
        denseWeight,
        sparseWeight,
        config,
      ),
    );
  }
  if (params.nowText && params.nowText.length > 0) {
    channels.push(
      await scoreChannel(
        "now",
        params.nowText,
        params.top,
        denseWeight,
        sparseWeight,
        config,
      ),
    );
  }

  return {
    config: { dense_weight: denseWeight, sparse_weight: sparseWeight },
    channels,
  };
}

// ── Fit anisotropy calibration ──────────────────────────────────────────

const MemoryV2FitAnisotropyParams = z
  .object({
    /**
     * Number of leading principal components to project out at apply time.
     * `1` is the canonical default for transformer embeddings; raise to 2-3
     * only when the variance spectrum shows multiple dominant directions.
     */
    k: z.number().int().min(1).max(16).default(1),
    /**
     * Maximum number of stored vectors to pull from Qdrant for the fit.
     * 5_000 is plenty for 3072-dim Gemini — power iteration converges fast
     * and pulling the full corpus would just cost wall-clock time.
     */
    sample: z.number().int().min(1).max(100_000).default(5_000),
  })
  .strict();

export interface MemoryV2FitAnisotropyResult {
  provider: string;
  model: string;
  dim: number;
  k: number;
  sampleCount: number;
  totalVariance: number;
  componentVariance: number[];
  /** `componentVariance[i] / totalVariance` for each component. */
  explainedVarianceRatio: number[];
  /** Absolute path the calibration was written to. */
  path: string;
}

async function handleFitAnisotropy({
  body = {},
}: RouteHandlerArgs): Promise<MemoryV2FitAnisotropyResult> {
  const { k, sample } = MemoryV2FitAnisotropyParams.parse(body);
  const config = loadConfig();

  const selection = await selectEmbeddingBackend(config);
  if (!selection.backend) {
    throw new RouteError(
      `Cannot fit anisotropy calibration: ${selection.reason ?? "no embedding backend configured"}`,
      "MEMORY_V2_NO_EMBEDDING_BACKEND",
      409,
    );
  }

  const vectors = await sampleConceptPageDenseVectors(sample);
  if (vectors.length === 0) {
    throw new RouteError(
      "Cannot fit anisotropy calibration: the v2 concept-page collection is empty. " +
        "Embed some concept pages first (run `assistant memory v2 reembed`), then retry.",
      "MEMORY_V2_NO_VECTORS",
      409,
    );
  }
  if (vectors.length < k * 4) {
    // PCA on too-few samples is unstable — refuse rather than hand back
    // overfit components. The 4× heuristic is conservative; in practice
    // anisotropy fits stabilise at a few hundred samples per component.
    throw new RouteError(
      `Cannot fit k=${k} components from only ${vectors.length} vectors — need at least ${k * 4}. ` +
        "Embed more concept pages or fit a smaller k.",
      "MEMORY_V2_INSUFFICIENT_VECTORS",
      409,
    );
  }

  const { provider, model } = selection.backend;
  const calib = fitAnisotropyCalibration(vectors, k, { provider, model });
  const path = await saveCalibration(calib);

  return {
    provider,
    model,
    dim: calib.dim,
    k,
    sampleCount: calib.sampleCount,
    totalVariance: calib.totalVariance,
    componentVariance: calib.componentVariance,
    explainedVarianceRatio: explainedVarianceRatio(calib),
    path,
  };
}

// ── Route definitions ───────────────────────────────────────────────────

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "memory_v2_backfill",
    method: "POST",
    endpoint: "memory/v2/backfill",
    handler: handleBackfill,
    summary: "Enqueue a memory v2 backfill job",
    description:
      "Enqueues one of four operator-triggered backfill jobs (migrate, rebuild-edges, reembed, activation-recompute) against the memory jobs queue.",
    tags: ["memory"],
    requestBody: MemoryV2BackfillParams,
  },
  {
    operationId: "memory_v2_validate",
    method: "POST",
    endpoint: "memory/v2/validate",
    handler: handleValidate,
    summary: "Validate memory v2 workspace state",
    description:
      "Read-only structural validation of the v2 workspace — reports orphan edges, oversized pages, and parse failures.",
    tags: ["memory"],
    requestBody: MemoryV2ValidateParams,
  },
  {
    operationId: "memory_v2_get_concept_page",
    method: "POST",
    endpoint: "memory/v2/concept-page",
    handler: handleGetConceptPage,
    summary: "Read a single memory v2 concept page",
    description:
      "Returns the rendered (frontmatter + body) markdown for a slug. 404 when the slug has no on-disk page — the activation log inspector uses this to show what got injected.",
    tags: ["memory"],
    requestBody: MemoryV2GetConceptPageParams,
  },
  {
    operationId: "memory_v2_reembed_skills",
    method: "POST",
    endpoint: "memory/v2/reembed-skills",
    handler: handleReembedSkills,
    summary: "Re-seed v2 skill entries from the current skill catalog",
    description:
      "Synchronously re-runs seedV2SkillEntries against the current skill catalog. Gated on memory-v2-enabled flag and config.memory.v2.enabled.",
    tags: ["memory"],
    requestBody: MemoryV2ReembedSkillsParams,
  },
  {
    operationId: "memory_v2_explain_similarity",
    method: "POST",
    endpoint: "memory/v2/explain-similarity",
    handler: handleExplainSimilarity,
    summary: "Diagnose dense vs sparse similarity score distributions",
    description:
      "Read-only diagnostic. Embeds the supplied text(s), runs hybrid dense + sparse queries against the concept-page collection, and returns per-slug raw dense, raw sparse, normalized sparse, and fused scores plus per-channel summary stats. Used to investigate score-compression at the head of the activation distribution.",
    tags: ["memory"],
    requestBody: MemoryV2ExplainSimilarityParams,
  },
  {
    operationId: "memory_v2_rebuild_corpus_stats",
    method: "POST",
    endpoint: "memory/v2/rebuild-corpus-stats",
    handler: handleRebuildCorpusStats,
    summary: "Rebuild the BM25 corpus statistics for memory v2",
    description:
      "Walks every concept page on disk, recomputes the document-frequency table and average document length used by the BM25 sparse channel, and atomically swaps the in-memory stats. Run after bulk content imports or to recover from a rebuild that errored at startup. Does not reembed individual page sparse vectors — pair with `assistant memory v2 reembed` when document-side weights need refreshing.",
    tags: ["memory"],
    requestBody: MemoryV2RebuildCorpusStatsParams,
  },
  {
    operationId: "memory_v2_fit_anisotropy",
    method: "POST",
    endpoint: "memory/v2/fit-anisotropy",
    handler: handleFitAnisotropy,
    summary: "Fit the embedding anisotropy correction for memory v2",
    description:
      "Samples stored dense vectors from the concept-page Qdrant collection, fits a corpus mean + top-k principal components (Mu & Viswanath 'all-but-the-top'), and persists the calibration so subsequent embeds and queries apply the correction. Run `assistant memory v2 reembed` after fitting so stored vectors are written under the new calibration — until then, queries (corrected) and stored vectors (uncorrected) live in different spaces.",
    tags: ["memory"],
    requestBody: MemoryV2FitAnisotropyParams,
  },
];
