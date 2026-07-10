// ---------------------------------------------------------------------------
// Memory v2 — Qdrant collection for concept pages
// ---------------------------------------------------------------------------
//
// Owns a dedicated Qdrant collection, keyed by concept-page slug, that holds
// dense + sparse embeddings of every page under `memory/concepts/`. The
// collection is separate from the v1 `memory` collection so v2 retrieval can
// roll out (and roll back) without disturbing the v1 graph + PKB hot path.
//
// Mirrors the dense + sparse named-vectors layout used by `VellumQdrantClient`
// in `qdrant-client.ts` (the v1 PKB collection setup pattern). Connection
// settings — URL, vector size, on-disk storage — flow through the same env →
// config precedence as v1 via `resolveQdrantUrl` and `config.memory.qdrant.*`,
// so users get a consistent Qdrant target without separate v2 knobs.
//
// Per-channel queries: `hybridQueryConceptPages` runs separate dense and
// sparse queries (no Qdrant-side RRF). Callers do their own weighted-sum
// fusion using `dense_weight` / `sparse_weight` from `config.memory.v2`,
// which RRF fusion would discard.

import { existsSync } from "node:fs";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { QdrantClient as QdrantRestClient } from "@qdrant/js-client-rest";
import { v5 as uuidv5 } from "uuid";

import { getConfig } from "../../../../config/loader.js";
import type { SparseEmbedding } from "../../../../persistence/embeddings/embedding-types.js";
import { resolveQdrantUrl } from "../embeddings.js";
import { getLogger } from "../logging.js";
import { getDataDir } from "../paths.js";

const log = getLogger("memory-v2-qdrant");

/** Name of the dedicated Qdrant collection holding concept-page embeddings. */
export const MEMORY_V2_COLLECTION = "memory_v2_concept_pages";

/**
 * Stable UUIDv5 namespace used to derive a deterministic Qdrant point ID from
 * a slug. The namespace is an arbitrary fixed UUID; what matters is that the
 * same slug always maps to the same point ID so upserts replace in place
 * instead of accumulating duplicates.
 */
const SLUG_NAMESPACE = "8b9c5d4f-0e1a-4f3b-9c2d-7e8f1a2b3c4d";

export interface ConceptPagePayload {
  slug: string;
  updated_at: number;
}

/** Per-channel score for a single concept-page hit returned by hybrid query. */
export interface ConceptPageQueryResult {
  slug: string;
  /**
   * Dense cosine similarity against the page body, when the slug appeared in
   * the body dense top-`limit`. `undefined` if the slug only appeared in the
   * sparse channel — or in a summary-side channel.
   */
  denseScore?: number;
  /**
   * Sparse score against the page body, when the slug appeared in the body
   * sparse top-`limit`. `undefined` if the slug only appeared in the dense
   * channel. Lives on a different scale than `denseScore` — callers must
   * normalize before fusing.
   */
  sparseScore?: number;
  /**
   * Dense cosine similarity against the page's frontmatter `summary`, when
   * the page has a summary embedded and the slug appeared in the summary
   * dense top-`limit`. `undefined` for pages without a summary embedding —
   * those fall back to body-only scoring.
   */
  summaryDenseScore?: number;
  /**
   * Sparse score against the page's frontmatter `summary`, paired with
   * `summaryDenseScore`. `undefined` for pages without a summary embedding.
   */
  summarySparseScore?: number;
}

let _client: QdrantRestClient | null = null;
let _collectionReady = false;
let _collectionReadyPromise: Promise<{ migrated: boolean }> | null = null;

/**
 * Named vectors the v2 concept-page collection must expose. Existing
 * collections that lack any of these get destructively recreated by
 * `ensureConceptPageCollectionOnce` — see the `migrated` return flag.
 */
const REQUIRED_DENSE_VECTORS = ["dense", "summary_dense"] as const;
const REQUIRED_SPARSE_VECTORS = ["sparse", "summary_sparse"] as const;

/**
 * Marker file written before the destructive collection-recreate path runs,
 * cleared by the lifecycle hook once the reembed job has been enqueued.
 *
 * The sentinel exists to close a narrow data-loss window in
 * `ensureConceptPageCollectionOnce`: a transient Qdrant failure between
 * `deleteCollection` and `createCollection` would otherwise lose the
 * "needs reembed" signal — `migrated` is reinitialized on the next call,
 * any subsequent caller (e.g. an upsert) recreates the collection empty,
 * and the lifecycle hook never enqueues the backfill. By persisting the
 * intent on disk *before* delete, the signal survives crashes and
 * intra-process retries: every later `ensureConceptPageCollection` call
 * returns `migrated: true` until the lifecycle hook enqueues the reembed
 * and clears the sentinel.
 */
const REEMBED_SENTINEL_FILENAME = ".memory-v2-reembed-required";

function reembedSentinelPath(): string {
  return join(getDataDir(), REEMBED_SENTINEL_FILENAME);
}

function reembedSentinelExists(): boolean {
  return existsSync(reembedSentinelPath());
}

async function writeReembedSentinel(): Promise<void> {
  const path = reembedSentinelPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "");
}

/**
 * Remove the reembed sentinel after the lifecycle hook has enqueued the
 * `memory_v2_reembed` job. Idempotent — missing-file is not an error.
 */
export async function clearReembedSentinel(): Promise<void> {
  try {
    await unlink(reembedSentinelPath());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

/** Lazily create a Qdrant REST client bound to the resolved URL. */
function getClient(): QdrantRestClient {
  if (_client) return _client;
  _client = new QdrantRestClient({
    url: resolveQdrantUrl(),
    checkCompatibility: false,
  });
  return _client;
}

/**
 * Create the v2 concept-page collection if it does not already exist, or
 * destructively recreate it when the existing schema is missing any of the
 * required named vectors (see `REQUIRED_DENSE_VECTORS` /
 * `REQUIRED_SPARSE_VECTORS`). The latter case is signalled to callers via
 * `{ migrated: true }` so they can enqueue a backfill — pre-#29823
 * collections lack `summary_dense` / `summary_sparse` and every query
 * referencing those named vectors fails with HTTP 400 until the collection
 * is rebuilt. Mirrors `VellumQdrantClient.ensureCollection` for v1.
 */
export async function ensureConceptPageCollection(): Promise<{
  migrated: boolean;
}> {
  if (_collectionReady) return { migrated: false };
  if (_collectionReadyPromise) return _collectionReadyPromise;

  _collectionReadyPromise = ensureConceptPageCollectionOnce().finally(() => {
    _collectionReadyPromise = null;
  });
  return _collectionReadyPromise;
}

async function ensureConceptPageCollectionOnce(): Promise<{
  migrated: boolean;
}> {
  const client = getClient();
  const config = getConfig();
  const vectorSize = config.memory.qdrant.vectorSize;
  const onDisk = config.memory.qdrant.onDisk;

  // A leftover sentinel means a prior call deleted the collection but never
  // got to enqueue the reembed (e.g. createCollection threw, or the process
  // died mid-rebuild). Carry that signal forward until the lifecycle hook
  // clears it.
  let migrated = reembedSentinelExists();

  try {
    const exists = await client.collectionExists(MEMORY_V2_COLLECTION);
    if (exists.exists) {
      // Assume compatible on probe failure rather than risk a destructive
      // recreate — mirrors v1's posture in `VellumQdrantClient.ensureCollection`.
      let info: Awaited<ReturnType<typeof client.getCollection>>;
      try {
        info = await client.getCollection(MEMORY_V2_COLLECTION);
      } catch (err) {
        log.warn(
          { err, collection: MEMORY_V2_COLLECTION },
          "Failed to probe v2 collection schema; assuming compatible",
        );
        _collectionReady = true;
        return { migrated: false };
      }

      const missing = missingNamedVectors(info);
      const wrongSize = wrongSizeNamedVectors(info, vectorSize);
      if (missing.length === 0 && wrongSize.length === 0) {
        // Long-lived installs may predate the `kind` payload index; ensure
        // every required index exists before declaring the collection ready.
        await ensurePayloadIndexes();
        await reconcileSparseIndexOnDisk(info, onDisk);
        _collectionReady = true;
        return { migrated: false };
      }

      if (missing.length === 0) {
        // Pure dimension drift: every required named vector is present, only
        // the sizes are wrong. This lazy path runs on hot upsert/query calls
        // and cannot run an embed probe to confirm the new dimension, so it
        // must not make the destroy-before-confirm decision. Destructive
        // dimension migration is owned by the probe-gated startup reconcile.
        log.warn(
          {
            collection: MEMORY_V2_COLLECTION,
            wrongSizeNamedVectors: wrongSize,
          },
          "Memory v2 concept-page collection dimension drift — deferring to startup reconcile; not recreating in the request path",
        );
        _collectionReady = true;
        return { migrated: false };
      }

      // Schema drift: required named vectors are missing (e.g. pre-#29823
      // collections without summary_dense / summary_sparse). This is safe,
      // provider-independent, and reproduces from disk, so recreate at the
      // configured size. When dimensions are also wrong, the recreate fixes
      // both at once.
      log.warn(
        {
          collection: MEMORY_V2_COLLECTION,
          missingNamedVectors: missing,
          wrongSizeNamedVectors: wrongSize,
        },
        "Memory v2 concept-page collection schema drift detected — deleting and recreating; embeddings will be regenerated by background reembed",
      );
      // Persist the reembed intent BEFORE the destructive delete so a crash
      // (or transient createCollection failure) between delete and recreate
      // still triggers reembed on the next ensure call.
      await writeReembedSentinel();
      await client.deleteCollection(MEMORY_V2_COLLECTION);
      migrated = true;
      // Fall through to creation below.
    }
  } catch (err) {
    // Treat "not found"-shaped errors as "needs creation" and fall through.
    if (!isCollectionMissing(err)) throw err;
  }

  log.info(
    { collection: MEMORY_V2_COLLECTION, vectorSize },
    "Creating Qdrant collection for memory v2 concept pages",
  );

  try {
    await client.createCollection(MEMORY_V2_COLLECTION, {
      vectors: {
        dense: {
          size: vectorSize,
          distance: "Cosine",
          on_disk: onDisk,
        },
        // Optional second dense vector covering the page's frontmatter
        // `summary`. Pages without a summary store nothing under this name —
        // Qdrant supports per-point named-vector subsets — so the named-vector
        // index stays cheap until summaries are populated.
        summary_dense: {
          size: vectorSize,
          distance: "Cosine",
          on_disk: onDisk,
        },
      },
      sparse_vectors: {
        // Sparse inverted indexes live in RAM unless placed on disk
        // explicitly; both channels follow the collection's on-disk setting.
        sparse: { index: { on_disk: onDisk } },
        summary_sparse: { index: { on_disk: onDisk } }, // BM25 sparse vector for the summary
      },
      hnsw_config: {
        on_disk: onDisk,
        m: 16,
        ef_construct: 100,
      },
      optimizers_config: {
        default_segment_number: 2,
      },
      on_disk_payload: onDisk,
    });
  } catch (err) {
    // 409 = a concurrent caller created the collection — that's fine.
    if (
      err instanceof Error &&
      "status" in err &&
      (err as { status: number }).status === 409
    ) {
      _collectionReady = true;
      return { migrated };
    }
    throw err;
  }

  await ensurePayloadIndexes();

  _collectionReady = true;
  return { migrated };
}

/**
 * Idempotently create the payload indexes the collection's query and
 * filter paths rely on:
 *
 *   - `slug` (keyword): every slug-restricted query and prefix scan filters on it.
 *   - `kind` (keyword): the skill-backfill scroll filters with `is_empty` on
 *     `kind`. Strict-mode Qdrant deployments reject filters on unindexed
 *     payload fields, so without this the backfill consistently fails and
 *     legacy skill points remain untagged.
 *
 * Same-schema `createPayloadIndex` calls are idempotent server-side in
 * Qdrant (200 OK), so the only "already exists" failures we expect are
 * narrow races where a concurrent caller created the same index a moment
 * earlier. Those are benign and swallowed. Every other failure — strict-mode
 * rejection, index-limit, transient network blip — must propagate so the
 * caller does not latch readiness on a collection whose `slug`/`kind`
 * filters will keep rejecting queries until the next daemon restart.
 */
async function ensurePayloadIndexes(): Promise<void> {
  const client = getClient();
  const indexes = [
    { field_name: "slug", field_schema: "keyword" as const },
    { field_name: "kind", field_schema: "keyword" as const },
  ];
  // Parallel so one "already exists" race on a single index doesn't stall
  // the other create round-trip. v1's `qdrant-client.ts` uses the same
  // Promise.all shape.
  await Promise.all(
    indexes.map(async (index) => {
      try {
        await client.createPayloadIndex(MEMORY_V2_COLLECTION, index);
      } catch (err) {
        if (isPayloadIndexAlreadyExists(err)) return;
        throw err;
      }
    }),
  );
}

/**
 * Align an existing collection's sparse-index placement with the configured
 * `onDisk` flag, covering both sparse channels. Qdrant keeps sparse inverted
 * indexes in RAM unless the collection explicitly opts into on-disk, and
 * collections keep whatever they were created with — `updateCollection` moves
 * them in place (the optimizer rewrites segments in the background) without a
 * reembed.
 *
 * Best-effort: a failed update logs and leaves the collection serving from
 * its current indexes — search keeps working either way.
 */
async function reconcileSparseIndexOnDisk(
  info: Awaited<ReturnType<QdrantRestClient["getCollection"]>>,
  onDisk: boolean,
): Promise<void> {
  const sparseParams = (
    info.config?.params as
      | {
          sparse_vectors?: Record<
            string,
            { index?: { on_disk?: boolean | null } | null } | undefined
          >;
        }
      | undefined
  )?.sparse_vectors;
  if (!sparseParams) return;

  // Only touch channels that exist in the collection and whose placement
  // drifts from the target — an update naming an absent sparse vector fails.
  const drifted = REQUIRED_SPARSE_VECTORS.filter(
    (name) =>
      name in sparseParams &&
      (sparseParams[name]?.index?.on_disk ?? false) !== onDisk,
  );
  if (drifted.length === 0) return;

  try {
    await getClient().updateCollection(MEMORY_V2_COLLECTION, {
      sparse_vectors: Object.fromEntries(
        drifted.map((name) => [name, { index: { on_disk: onDisk } }]),
      ),
    });
    log.info(
      { collection: MEMORY_V2_COLLECTION, sparseVectors: drifted, onDisk },
      "Moved sparse index placement on existing Qdrant collection",
    );
  } catch (err) {
    log.warn(
      { err, collection: MEMORY_V2_COLLECTION, sparseVectors: drifted, onDisk },
      "Failed to update sparse index placement — continuing with current indexes",
    );
  }
}

/**
 * True when a `createPayloadIndex` error indicates the index already
 * exists with matching parameters — the only failure shape it is safe to
 * swallow. Qdrant returns 4xx with messages like
 * `"Wrong input: Payload field 'kind' already exists ..."`.
 */
function isPayloadIndexAlreadyExists(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /already exists/i.test(msg);
}

/**
 * Return the names of required named vectors absent from the collection's
 * current schema. An empty array means the collection is fully migrated.
 *
 * If the response shape is unparseable (e.g. Qdrant returns an unexpected
 * structure) we treat it as "everything is missing" so the caller's drift
 * branch fires — combined with the `getCollection` try/catch in the caller,
 * a thrown probe falls back to "assume compatible" while a parsed-but-empty
 * response triggers the safer recreate.
 */
function missingNamedVectors(
  info: Awaited<ReturnType<QdrantRestClient["getCollection"]>>,
): string[] {
  const params = info.config?.params;
  const dense = params?.vectors;
  const sparse = (params as { sparse_vectors?: unknown } | undefined)
    ?.sparse_vectors;
  const denseNames =
    dense && typeof dense === "object" && !("size" in dense)
      ? new Set(Object.keys(dense))
      : new Set<string>();
  const sparseNames =
    sparse && typeof sparse === "object"
      ? new Set(Object.keys(sparse as Record<string, unknown>))
      : new Set<string>();

  const missing: string[] = [];
  for (const name of REQUIRED_DENSE_VECTORS) {
    if (!denseNames.has(name)) missing.push(name);
  }
  for (const name of REQUIRED_SPARSE_VECTORS) {
    if (!sparseNames.has(name)) missing.push(name);
  }
  return missing;
}

/**
 * Return the names of required dense named vectors that are PRESENT but sized
 * to a different dimension than `expectedSize`. A collection created under a
 * different embedding model (e.g. a 384-dim collection now serving a 3072-dim
 * embedder) has all its named vectors but at the wrong dimension — every upsert
 * then fails with HTTP 400, and the {@link missingNamedVectors} check alone
 * never detects it. Combined with that check, this triggers the same
 * destructive recreate + reembed path.
 *
 * Only dense vectors carry an explicit `size`; sparse vectors are dimensionless
 * and are not checked. A single unnamed-vector shape (top-level `size`) or an
 * unparseable response returns `[]`.
 */
function wrongSizeNamedVectors(
  info: Awaited<ReturnType<QdrantRestClient["getCollection"]>>,
  expectedSize: number,
): string[] {
  const dense = info.config?.params?.vectors;
  // Named-vectors map only — mirror the `!("size" in dense)` guard in
  // `missingNamedVectors`. A single unnamed vector exposes `size` at the top
  // level; its dimension is the collection's and is handled by the caller.
  if (!dense || typeof dense !== "object" || "size" in dense) return [];
  const map = dense as Record<string, unknown>;
  const wrong: string[] = [];
  for (const name of REQUIRED_DENSE_VECTORS) {
    const entry = map[name];
    if (entry && typeof entry === "object" && "size" in entry) {
      const size = (entry as { size?: unknown }).size;
      if (typeof size === "number" && size !== expectedSize) wrong.push(name);
    }
  }
  return wrong;
}

/**
 * Upsert a concept page's dense + sparse embedding. The point ID is derived
 * deterministically from the slug so subsequent calls for the same slug
 * replace the prior point in place rather than accumulating duplicates.
 *
 * `summary` is optional — supplied when the page's frontmatter carries a
 * `summary`, omitted otherwise. Pages without a summary store only the body
 * vectors and fall back to body-only scoring at query time. The grouped
 * shape enforces at the type level that summary dense and sparse are
 * always written together.
 */
export async function upsertConceptPageEmbedding(params: {
  slug: string;
  dense: number[];
  sparse: SparseEmbedding;
  summary?: { dense: number[]; sparse: SparseEmbedding };
  updatedAt: number;
  /**
   * Optional payload discriminator. Used to distinguish skill-seeded points
   * (`kind: "skill"`) from user-authored concept pages so namespace pruning
   * via {@link pruneSlugsWithPrefixExcept} can scope deletes to a single kind.
   * Omitted for plain concept pages.
   */
  kind?: string;
}): Promise<void> {
  await ensureConceptPageCollection();

  const { slug, dense, sparse, summary, updatedAt, kind } = params;
  const client = getClient();
  const pointId = pointIdForSlug(slug);

  // Qdrant lets us upsert any subset of named vectors per point. The summary
  // entries appear only when the caller passed a `summary` block — pairing
  // them at the type level keeps query-time fusion symmetric with the body
  // channels.
  const vector: Record<string, number[] | SparseEmbedding> = { dense, sparse };
  if (summary) {
    vector.summary_dense = summary.dense;
    vector.summary_sparse = summary.sparse;
  }

  const payload: Record<string, unknown> = { slug, updated_at: updatedAt };
  if (kind !== undefined) payload.kind = kind;

  const upsertOnce = () =>
    client.upsert(MEMORY_V2_COLLECTION, {
      wait: true,
      points: [
        {
          id: pointId,
          vector,
          payload,
        },
      ],
    });

  try {
    await upsertOnce();
  } catch (err) {
    if (isCollectionMissing(err)) {
      _collectionReady = false;
      await ensureConceptPageCollection();
      await upsertOnce();
      return;
    }
    throw err;
  }
}

/** Remove the embedding for a slug. Idempotent: no-op when the slug is absent. */
export async function deleteConceptPageEmbedding(slug: string): Promise<void> {
  await ensureConceptPageCollection();

  const client = getClient();
  const doDelete = () =>
    client.delete(MEMORY_V2_COLLECTION, {
      wait: true,
      points: [pointIdForSlug(slug)],
    });

  try {
    await doDelete();
  } catch (err) {
    if (isCollectionMissing(err)) {
      _collectionReady = false;
      await ensureConceptPageCollection();
      await doDelete();
      return;
    }
    throw err;
  }
}

/**
 * Remove every point whose slug starts with the given prefix and whose
 * remaining suffix is not in `activeSuffixes`. Used by the skill-seed flow to
 * drop stale `skills/<id>` slugs after a skill is uninstalled or disabled,
 * since skills now share the concept-page collection rather than living in a
 * dedicated one.
 *
 * `kind` scopes pruning to a payload discriminator: only points whose
 * `payload.kind` matches are eligible for deletion. This is critical because
 * `validateSlug` permits user-authored concept pages slugged like
 * `skills/foo`; without a kind filter they would collide with the skill
 * namespace and be repeatedly pruned every seed run. The companion
 * {@link backfillKindOnPointsWithPrefix} preserves this invariant for legacy
 * untagged rows by tagging only suffixes the caller knows are skills —
 * user-authored `skills/<slug>` rows stay kindless and outside this prune.
 *
 * Idempotent: when the live `<prefix>*` slugs already match `activeSuffixes`,
 * the function performs a single scroll and no deletes.
 */
export async function pruneSlugsWithPrefixExcept(
  prefix: string,
  activeSuffixes: readonly string[],
  options: { kind?: string } = {},
): Promise<void> {
  await ensureConceptPageCollection();

  const client = getClient();
  const activeSet = new Set(activeSuffixes);
  const requiredKind = options.kind;

  const doPrune = async (): Promise<void> => {
    const stalePointIds: Array<string | number> = [];
    let offset: string | number | undefined = undefined;
    const maxIterations = 10_000;
    const batchSize = 256;
    for (let i = 0; i < maxIterations; i++) {
      const result = await client.scroll(MEMORY_V2_COLLECTION, {
        limit: batchSize,
        with_payload: true,
        with_vector: false,
        ...(offset !== undefined ? { offset } : {}),
      });
      for (const point of result.points) {
        const payload = point.payload as {
          slug?: unknown;
          kind?: unknown;
        } | null;
        const slug = payload?.slug;
        if (typeof slug !== "string") continue;
        if (!slug.startsWith(prefix)) continue;
        if (requiredKind !== undefined && payload?.kind !== requiredKind)
          continue;
        const suffix = slug.slice(prefix.length);
        if (!activeSet.has(suffix)) {
          stalePointIds.push(point.id);
        }
      }
      const next = result.next_page_offset;
      if (next == null) break;
      offset = typeof next === "string" ? next : (next as number);
    }

    if (stalePointIds.length === 0) return;

    await client.delete(MEMORY_V2_COLLECTION, {
      wait: true,
      points: stalePointIds,
    });
  };

  try {
    await doPrune();
  } catch (err) {
    if (isCollectionMissing(err)) {
      _collectionReady = false;
      await ensureConceptPageCollection();
      await doPrune();
      return;
    }
    throw err;
  }
}

/**
 * Set `payload.kind` on every point whose slug starts with `prefix`, whose
 * suffix is in `allowedSuffixes`, and is currently missing the `kind`
 * discriminator. Used to tag legacy rows that predate the kind field so the
 * kind-scoped {@link pruneSlugsWithPrefixExcept} no longer leaves them as
 * orphans.
 *
 * `allowedSuffixes` is required because `validateSlug` permits user-authored
 * concept pages slugged like `skills/my-notes` — those rows also lack `kind`
 * and would otherwise be tagged here and then deleted by the kind-scoped
 * prune. Callers must pass the closed set of legitimate suffixes (e.g. the
 * union of installed + remote-catalog skill IDs) so user pages stay untagged.
 *
 * The "missing kind" predicate is pushed to Qdrant via `is_empty`, so once
 * every legacy row has been tagged the scroll returns the bounded set of
 * other kindless concept pages without ever touching the already-tagged
 * rows. Idempotent across retries: a row tagged by an earlier partial run
 * no longer matches the filter and is silently skipped.
 */
export async function backfillKindOnPointsWithPrefix(
  prefix: string,
  kind: string,
  allowedSuffixes: ReadonlySet<string>,
): Promise<number> {
  if (allowedSuffixes.size === 0) return 0;
  await ensureConceptPageCollection();

  const client = getClient();

  const doBackfill = async (): Promise<number> => {
    const pointIds: Array<string | number> = [];
    let offset: string | number | undefined = undefined;
    const maxIterations = 10_000;
    const batchSize = 256;
    for (let i = 0; i < maxIterations; i++) {
      const result = await client.scroll(MEMORY_V2_COLLECTION, {
        limit: batchSize,
        with_payload: true,
        with_vector: false,
        filter: { must: [{ is_empty: { key: "kind" } }] },
        ...(offset !== undefined ? { offset } : {}),
      });
      for (const point of result.points) {
        const slug = (point.payload as { slug?: unknown } | null)?.slug;
        if (typeof slug !== "string") continue;
        if (!slug.startsWith(prefix)) continue;
        const suffix = slug.slice(prefix.length);
        if (!allowedSuffixes.has(suffix)) continue;
        pointIds.push(point.id);
      }
      const next = result.next_page_offset;
      if (next == null) break;
      offset = typeof next === "string" ? next : (next as number);
    }

    if (pointIds.length === 0) return 0;

    await client.setPayload(MEMORY_V2_COLLECTION, {
      payload: { kind },
      points: pointIds,
      wait: true,
    });
    return pointIds.length;
  };

  try {
    return await doBackfill();
  } catch (err) {
    if (isCollectionMissing(err)) {
      _collectionReady = false;
      await ensureConceptPageCollection();
      return await doBackfill();
    }
    throw err;
  }
}

/**
 * Approximate count of points in the v2 concept-page collection. Used by the
 * daemon-startup rebuild hook to detect "collection exists but empty" — the
 * crash-mid-rebuild recovery case where a prior boot dropped + recreated the
 * collection but died before reembed completed. Returns `0` if the collection
 * does not exist or the count call fails (treated as "needs reembed" by the
 * caller).
 */
export async function countConceptPagePoints(): Promise<number> {
  await ensureConceptPageCollection();
  try {
    const result = await getClient().count(MEMORY_V2_COLLECTION, {
      exact: false,
    });
    return result.count;
  } catch (err) {
    log.warn(
      { err, collection: MEMORY_V2_COLLECTION },
      "Failed to count v2 concept-page collection — treating as empty",
    );
    return 0;
  }
}

/**
 * Destructively delete and recreate the v2 concept-page collection at the
 * configured `config.memory.qdrant.vectorSize`. Owned by the probe-gated
 * startup reconcile, which is the only path permitted to make the
 * destroy-before-confirm decision for a dimension migration (the lazy
 * `ensureConceptPageCollection` path explicitly defers dimension drift here).
 *
 * Resets the in-process readiness latch and delegates creation to
 * `ensureConceptPageCollection` so the named-vector layout, payload indexes,
 * and reembed sentinel all flow through the single creation code path.
 * Idempotent against an absent collection — a missing collection is treated as
 * "already deleted" and the recreate proceeds.
 */
export async function recreateConceptPageCollection(): Promise<void> {
  const client = getClient();
  try {
    await client.deleteCollection(MEMORY_V2_COLLECTION);
  } catch (err) {
    if (!isCollectionMissing(err)) throw err;
  }
  _collectionReady = false;
  _collectionReadyPromise = null;
  await ensureConceptPageCollection();
}

/**
 * Probe whether the v2 concept-page collection currently exists in Qdrant
 * **without** triggering creation. Read-only diagnostics use this to avoid
 * the side effect of bootstrapping storage just by inspecting it.
 */
export async function conceptPageCollectionExists(): Promise<boolean> {
  const client = getClient();
  try {
    const result = await client.collectionExists(MEMORY_V2_COLLECTION);
    return result.exists;
  } catch (err) {
    if (isCollectionMissing(err)) return false;
    throw err;
  }
}

/**
 * Best-effort delete of the legacy `memory_v2_skills` Qdrant collection. Skill
 * embeddings now live alongside concept pages in `memory_v2_concept_pages`
 * under the `skills/<id>` slug prefix, so the dedicated collection is dead
 * weight on installs upgraded from the split-collection era. Fire-and-forget:
 * on a fresh install (collection never existed) or a transient Qdrant
 * unavailable, we log and move on.
 */
export async function dropLegacySkillsCollection(): Promise<void> {
  try {
    const client = getClient();
    const exists = await client.collectionExists("memory_v2_skills");
    if (!exists.exists) return;
    await client.deleteCollection("memory_v2_skills");
    log.info("Deleted legacy memory_v2_skills Qdrant collection");
  } catch (err) {
    log.warn(
      { err },
      "Failed to drop legacy memory_v2_skills collection — non-fatal",
    );
  }
}

/**
 * Run separate dense and sparse queries against the concept-page collection
 * and return per-channel scores per slug. Callers fuse these — typically via
 * a normalized weighted-sum — because RRF would discard the score magnitudes
 * the activation formula needs.
 *
 * Four channels are queried concurrently: body dense, body sparse, summary
 * dense, summary sparse. The summary channels only return hits for pages whose
 * frontmatter carries a `summary` (and therefore stored `summary_dense` /
 * `summary_sparse` named vectors at upsert time). Pages without a summary
 * surface body-only scores; callers fall back to body-only fusion for those.
 *
 * Each channel returns up to `limit` hits. A slug is included in the result
 * if it appears in any channel; missing channel scores stay `undefined` so
 * callers can distinguish "no match in this channel" from "match with score 0".
 *
 * `restrictToSlugs`, when provided, filters the search server-side to only
 * those slugs (Qdrant `slug IN [...]` filter). Used by `simBatch` when the
 * candidate set is already known so we don't waste hits on unrelated pages.
 * An empty list short-circuits to no results — the caller is asking for
 * "nothing", not "everything".
 *
 * An empty `dense` vector runs a sparse-only query: the dense channels are
 * skipped rather than sent to Qdrant (a 0-dimension vector would 400). This is
 * the dense counterpart to the `skipSparse` option.
 */
export async function hybridQueryConceptPages(
  dense: number[],
  sparse: SparseEmbedding,
  limit: number,
  restrictToSlugs?: readonly string[],
  options?: { skipSparse?: boolean },
): Promise<ConceptPageQueryResult[]> {
  if (restrictToSlugs && restrictToSlugs.length === 0) {
    // An empty restriction means "no candidates"; skip the round-trip.
    return [];
  }

  await ensureConceptPageCollection();

  const client = getClient();
  const filter = restrictToSlugs
    ? { must: [{ key: "slug", match: { any: [...restrictToSlugs] } }] }
    : undefined;

  // When the caller weighted sparse to zero, skip the round-trip entirely.
  // The downstream fuser (`fuseHit` in `sim.ts`) already treats a missing
  // sparse score as a 0 contribution, so omitting the query is a pure
  // optimization — and it's also the kill switch operators use to dodge a
  // Qdrant 1.13.x sparse-index crash that we've reproduced in the wild.
  const skipSparse = options?.skipSparse ?? false;

  // An empty dense query vector means "sparse-only": skip the dense channels
  // instead of sending a 0-dimension vector to Qdrant (which rejects it with a
  // "Vector dimension error: expected dim N, got 0" 400). Symmetric to
  // skipSparse — the fuser treats a missing dense score as a 0 contribution, so
  // omitting the dense query is equivalent to weighting it to zero. Callers like
  // the v3 sparse scout lane rely on this to run a BM25-only query.
  const skipDense = dense.length === 0;

  const queryDense = (using: string) =>
    client.query(MEMORY_V2_COLLECTION, {
      query: dense,
      using,
      limit,
      with_payload: true,
      filter,
    });
  const querySparse = (using: string) =>
    client.query(MEMORY_V2_COLLECTION, {
      query: sparse,
      using,
      limit,
      with_payload: true,
      filter,
    });

  // Run all four channels concurrently — they hit independent named vectors.
  // When sparse is gated off the sparse channels still resolve a Promise so
  // the destructuring below stays uniform; the empty `points: []` matches
  // the shape of a no-hit Qdrant response.
  const emptyResult = {
    points: [] as Array<{ payload?: unknown; score?: number }>,
  };
  const runQueries = async () =>
    Promise.all([
      skipDense ? emptyResult : queryDense("dense"),
      skipSparse ? emptyResult : querySparse("sparse"),
      skipDense ? emptyResult : queryDense("summary_dense"),
      skipSparse ? emptyResult : querySparse("summary_sparse"),
    ]);

  let denseResults;
  let sparseResults;
  let summaryDenseResults;
  let summarySparseResults;
  try {
    [denseResults, sparseResults, summaryDenseResults, summarySparseResults] =
      await runQueries();
  } catch (err) {
    if (isCollectionMissing(err)) {
      _collectionReady = false;
      await ensureConceptPageCollection();
      [denseResults, sparseResults, summaryDenseResults, summarySparseResults] =
        await runQueries();
    } else {
      throw err;
    }
  }

  // Merge by slug. Missing-side scores stay undefined so the fuser can tell
  // "no match in this channel" apart from "match with score 0".
  const merged = new Map<string, ConceptPageQueryResult>();
  const recordHit = (
    points: Array<{ payload?: unknown; score?: number }> | undefined,
    set: (entry: ConceptPageQueryResult, score: number) => void,
  ): void => {
    for (const point of points ?? []) {
      const slug = (point.payload as { slug?: unknown } | null)?.slug;
      if (typeof slug !== "string") continue;
      const existing = merged.get(slug) ?? { slug };
      set(existing, point.score ?? 0);
      merged.set(slug, existing);
    }
  };
  recordHit(denseResults.points, (e, s) => (e.denseScore = s));
  recordHit(sparseResults.points, (e, s) => (e.sparseScore = s));
  recordHit(summaryDenseResults.points, (e, s) => (e.summaryDenseScore = s));
  recordHit(summarySparseResults.points, (e, s) => (e.summarySparseScore = s));

  return Array.from(merged.values());
}

/**
 * Detect "collection not found" errors so callers can reset readiness and
 * retry after an external deletion (e.g. workspace reset).
 */
function isCollectionMissing(err: unknown): boolean {
  if (
    err &&
    typeof err === "object" &&
    "status" in err &&
    (err as { status: number }).status === 404
  ) {
    return true;
  }
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes("Not found") ||
    msg.includes("doesn't exist") ||
    msg.includes("not found")
  );
}

/**
 * Derive the deterministic Qdrant point ID for a slug. Qdrant requires
 * UUID/integer IDs; UUIDv5 keeps the mapping stable across processes so
 * upserts replace in place.
 */
function pointIdForSlug(slug: string): string {
  return uuidv5(slug, SLUG_NAMESPACE);
}

/** @internal Test-only: reset module-level singletons. */
export function _resetMemoryV2QdrantForTests(): void {
  _client = null;
  _collectionReady = false;
  _collectionReadyPromise = null;
}
