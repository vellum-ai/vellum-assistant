import { QdrantClient as QdrantRestClient } from "@qdrant/js-client-rest";
import { v4 as uuid } from "uuid";

import { getLogger } from "../util/logger.js";

const log = getLogger("qdrant-client");

export interface QdrantSparseVector {
  indices: number[];
  values: number[];
}

export interface QdrantClientConfig {
  url: string;
  collection: string;
  vectorSize: number;
  onDisk: boolean;
  quantization: "scalar" | "none";
  embeddingModel?: string;
}

export interface QdrantPointPayload {
  target_type: "segment" | "item" | "summary" | "media";
  target_id: string;
  text: string;
  kind?: string;
  subject?: string;
  status?: string;
  importance?: number;
  confidence?: number;
  created_at: number;
  last_seen_at?: number;
  conversation_id?: string;
  message_id?: string;
  memory_scope_id?: string;
  modality?: "text" | "image" | "audio" | "video";
}

export interface QdrantSearchResult {
  id: string;
  score: number;
  payload: QdrantPointPayload;
}

let _instance: VellumQdrantClient | null = null;

export function getQdrantClient(): VellumQdrantClient {
  if (!_instance) {
    throw new Error(
      "Qdrant client not initialized. Call initQdrantClient() first.",
    );
  }
  return _instance;
}

export function initQdrantClient(
  config: QdrantClientConfig,
): VellumQdrantClient {
  _instance = new VellumQdrantClient(config);
  return _instance;
}

export class VellumQdrantClient {
  private readonly client: QdrantRestClient;
  private readonly collection: string;
  private readonly vectorSize: number;
  private readonly onDisk: boolean;
  private readonly quantization: "scalar" | "none";
  private readonly embeddingModel?: string;
  private collectionReady = false;

  private readonly SENTINEL_ID = "00000000-0000-0000-0000-000000000000";

  constructor(config: QdrantClientConfig) {
    this.client = new QdrantRestClient({
      url: config.url,
      checkCompatibility: false,
    });
    this.collection = config.collection;
    this.vectorSize = config.vectorSize;
    this.onDisk = config.onDisk;
    this.quantization = config.quantization;
    this.embeddingModel = config.embeddingModel;
  }

  async ensureCollection(): Promise<{ migrated: boolean }> {
    if (this.collectionReady) return { migrated: false };

    let migrated = false;

    try {
      const exists = await this.client.collectionExists(this.collection);
      if (exists.exists) {
        try {
          const info = await this.client.getCollection(this.collection);
          const vectorsConfig = info.config?.params?.vectors;

          // Detect whether the collection uses unnamed vectors (legacy) vs named vectors
          const isUnnamedVectors =
            vectorsConfig != null &&
            typeof vectorsConfig === "object" &&
            "size" in vectorsConfig;

          const currentSize = isUnnamedVectors
            ? (vectorsConfig as { size?: number })?.size
            : (vectorsConfig as Record<string, { size?: number }> | undefined)
                ?.dense?.size;

          const dimMismatch =
            currentSize != null && currentSize !== this.vectorSize;

          // Check model identity via a sentinel point that stores the embedding model
          let modelMismatch = false;
          if (this.embeddingModel) {
            const sentinel = await this.readSentinel();
            if (sentinel && sentinel !== this.embeddingModel) {
              modelMismatch = true;
            }
          }

          if (isUnnamedVectors) {
            log.warn(
              {
                collection: this.collection,
                currentSize,
                expectedSize: this.vectorSize,
              },
              "Qdrant collection uses unnamed vectors (legacy) — deleting and recreating with named vectors. Embeddings will be re-indexed.",
            );
            await this.client.deleteCollection(this.collection);
            migrated = true;
            // Fall through to collection creation below
          } else if (dimMismatch || modelMismatch) {
            log.warn(
              {
                collection: this.collection,
                currentSize,
                expectedSize: this.vectorSize,
                modelMismatch,
              },
              "Qdrant collection incompatible (dimension or model change) — deleting and recreating. Embeddings will be regenerated on demand.",
            );
            await this.client.deleteCollection(this.collection);
            migrated = true;
            // Fall through to collection creation below
          } else {
            if (await this.ensurePayloadIndexesSafe()) {
              this.collectionReady = true;
            }
            return { migrated: false };
          }
        } catch (err) {
          log.warn(
            { err },
            "Failed to verify collection compatibility, assuming compatible",
          );
          if (await this.ensurePayloadIndexesSafe()) {
            this.collectionReady = true;
          }
          return { migrated: false };
        }
      }
    } catch {
      // Collection doesn't exist, create it
    }

    log.info(
      { collection: this.collection, vectorSize: this.vectorSize },
      "Creating Qdrant collection with named vectors (dense + sparse)",
    );

    try {
      await this.client.createCollection(this.collection, {
        vectors: {
          dense: {
            size: this.vectorSize,
            distance: "Cosine",
            on_disk: this.onDisk,
          },
        },
        sparse_vectors: {
          sparse: {}, // Qdrant auto-infers sparse vector params
        },
        hnsw_config: {
          on_disk: this.onDisk,
          m: 16,
          ef_construct: 100,
        },
        quantization_config:
          this.quantization === "scalar"
            ? {
                scalar: {
                  type: "int8",
                  quantile: 0.99,
                  always_ram: true,
                },
              }
            : undefined,
        on_disk_payload: this.onDisk,
      });
    } catch (err) {
      // 409 = collection was created by a concurrent caller — that's fine
      if (
        err instanceof Error &&
        "status" in err &&
        (err as { status: number }).status === 409
      ) {
        if (await this.ensurePayloadIndexesSafe()) {
          this.collectionReady = true;
        }
        return { migrated };
      }
      throw err;
    }

    if (await this.ensurePayloadIndexesSafe()) {
      // Write sentinel point to record the active embedding model
      if (this.embeddingModel) {
        await this.writeSentinel(this.embeddingModel);
      }

      this.collectionReady = true;
      log.info(
        { collection: this.collection },
        "Qdrant collection created with payload indexes",
      );
    }

    return { migrated };
  }

  async upsert(
    targetType: "segment" | "item" | "summary" | "media",
    targetId: string,
    vector: number[],
    payload: Omit<QdrantPointPayload, "target_type" | "target_id">,
    sparseVector?: QdrantSparseVector,
  ): Promise<string> {
    await this.ensureCollection();

    // Deterministic point ID: look up existing point by target_type + target_id
    const existing = await this.findByTarget(targetType, targetId);
    const pointId = existing ?? uuid();

    const namedVector: Record<
      string,
      number[] | { indices: number[]; values: number[] }
    > = {
      dense: vector,
    };
    if (sparseVector) {
      namedVector.sparse = {
        indices: sparseVector.indices,
        values: sparseVector.values,
      };
    }

    const point = {
      id: pointId,
      vector: namedVector,
      payload: {
        target_type: targetType,
        target_id: targetId,
        ...payload,
      },
    };

    try {
      await this.client.upsert(this.collection, {
        wait: true,
        points: [point],
      });
    } catch (err) {
      if (this.isCollectionMissing(err)) {
        this.collectionReady = false;
        await this.ensureCollection();
        await this.client.upsert(this.collection, {
          wait: true,
          points: [point],
        });
      } else {
        throw err;
      }
    }

    return pointId;
  }

  async search(
    vector: number[],
    limit: number,
    filter?: Record<string, unknown>,
  ): Promise<QdrantSearchResult[]> {
    await this.ensureCollection();

    const searchParams = {
      vector: { name: "dense", vector },
      limit,
      with_payload: true,
      score_threshold: 0.0,
      filter: filter as Parameters<QdrantRestClient["search"]>[1]["filter"],
    };

    let results;
    try {
      results = await this.client.search(this.collection, searchParams);
    } catch (err) {
      if (this.isCollectionMissing(err)) {
        this.collectionReady = false;
        await this.ensureCollection();
        results = await this.client.search(this.collection, searchParams);
      } else {
        throw err;
      }
    }

    return results.map((result) => ({
      id: typeof result.id === "string" ? result.id : String(result.id),
      score: result.score,
      payload: result.payload as unknown as QdrantPointPayload,
    }));
  }

  async searchWithFilter(
    vector: number[],
    limit: number,
    targetTypes: Array<"segment" | "item" | "summary" | "media">,
    excludeMessageIds?: string[],
    scopeIds?: string[],
  ): Promise<QdrantSearchResult[]> {
    const mustConditions: Array<Record<string, unknown>> = [
      {
        key: "target_type",
        match: { any: targetTypes },
      },
    ];

    if (excludeMessageIds && excludeMessageIds.length > 0) {
      // Only require status=active for items; segments and summaries don't have a status field
      mustConditions.push({
        should: [
          {
            must: [
              { key: "target_type", match: { value: "item" } },
              { key: "status", match: { value: "active" } },
            ],
          },
          {
            key: "target_type",
            match: { any: ["segment", "summary", "media"] },
          },
        ],
      });
    }

    // Scope filtering: accept points whose memory_scope_id matches one of the
    // allowed scopes, OR points that lack the field entirely (legacy data).
    // Post-query DB filtering remains as defense-in-depth for legacy points.
    if (scopeIds && scopeIds.length > 0) {
      mustConditions.push({
        should: [
          { key: "memory_scope_id", match: { any: scopeIds } },
          { is_empty: { key: "memory_scope_id" } },
        ],
      });
    }

    const mustNotConditions: Array<Record<string, unknown>> = [
      { key: "_meta", match: { value: true } },
    ];
    if (excludeMessageIds && excludeMessageIds.length > 0) {
      mustNotConditions.push({
        key: "message_id",
        match: { any: excludeMessageIds },
      });
    }

    const filter: Record<string, unknown> = {
      must: mustConditions,
      must_not: mustNotConditions,
    };

    return this.search(vector, limit, filter);
  }

  /**
   * Hybrid search using both dense and sparse vectors with RRF fusion.
   * Performs two prefetch queries (dense + sparse) and fuses results
   * using Reciprocal Rank Fusion via Qdrant's query API.
   */
  async hybridSearch(params: {
    denseVector: number[];
    sparseVector: QdrantSparseVector;
    filter?: object;
    limit: number;
    prefetchLimit?: number;
  }): Promise<QdrantSearchResult[]> {
    await this.ensureCollection();

    const { denseVector, sparseVector, filter, limit, prefetchLimit } = params;
    const effectivePrefetchLimit = prefetchLimit ?? 40;

    const queryParams = {
      prefetch: [
        {
          query: denseVector as unknown as number[],
          using: "dense",
          limit: effectivePrefetchLimit,
        },
        {
          query: {
            indices: sparseVector.indices,
            values: sparseVector.values,
          },
          using: "sparse",
          limit: effectivePrefetchLimit,
        },
      ],
      query: { fusion: "rrf" as const },
      limit,
      filter: filter as Record<string, unknown> | undefined,
      with_payload: true,
    };

    let results;
    try {
      results = await this.client.query(this.collection, queryParams);
    } catch (err) {
      if (this.isCollectionMissing(err)) {
        this.collectionReady = false;
        await this.ensureCollection();
        results = await this.client.query(this.collection, queryParams);
      } else {
        throw err;
      }
    }

    return (results.points ?? []).map((point) => ({
      id: typeof point.id === "string" ? point.id : String(point.id),
      score: point.score ?? 0,
      payload: point.payload as unknown as QdrantPointPayload,
    }));
  }

  async deleteByTarget(targetType: string, targetId: string): Promise<void> {
    await this.ensureCollection();

    const doDelete = () =>
      this.client.delete(this.collection, {
        wait: true,
        filter: {
          must: [
            { key: "target_type", match: { value: targetType } },
            { key: "target_id", match: { value: targetId } },
          ],
        },
      });

    try {
      await doDelete();
    } catch (err) {
      if (this.isCollectionMissing(err)) {
        this.collectionReady = false;
        await this.ensureCollection();
        await doDelete();
      } else {
        throw err;
      }
    }
  }

  async count(): Promise<number> {
    await this.ensureCollection();

    try {
      const result = await this.client.count(this.collection, { exact: false });
      return result.count;
    } catch (err) {
      if (this.isCollectionMissing(err)) {
        this.collectionReady = false;
        await this.ensureCollection();
        const result = await this.client.count(this.collection, {
          exact: false,
        });
        return result.count;
      }
      throw err;
    }
  }

  async deleteCollection(): Promise<boolean> {
    try {
      const exists = await this.client.collectionExists(this.collection);
      if (!exists.exists) return false;
      await this.client.deleteCollection(this.collection);
      this.collectionReady = false;
      return true;
    } catch (err) {
      log.warn(
        { err, collection: this.collection },
        "Failed to delete Qdrant collection",
      );
      return false;
    }
  }

  /**
   * Detect "collection not found" errors from Qdrant so callers can
   * reset collectionReady and retry after an external deletion
   * (e.g. `assistant sessions clear`).
   */
  private isCollectionMissing(err: unknown): boolean {
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
   * Wraps ensurePayloadIndexes so that a 404 (collection deleted between
   * our existence check and index creation) resets collectionReady instead
   * of propagating — the next operation will self-heal via ensureCollection.
   */
  private async ensurePayloadIndexesSafe(): Promise<boolean> {
    try {
      await this.ensurePayloadIndexes();
      return true;
    } catch (err) {
      if (this.isCollectionMissing(err)) {
        this.collectionReady = false;
        return false;
      }
      throw err;
    }
  }

  private async ensurePayloadIndexes(): Promise<void> {
    await Promise.all([
      this.client.createPayloadIndex(this.collection, {
        field_name: "target_type",
        field_schema: "keyword",
      }),
      this.client.createPayloadIndex(this.collection, {
        field_name: "target_id",
        field_schema: "keyword",
      }),
      this.client.createPayloadIndex(this.collection, {
        field_name: "kind",
        field_schema: "keyword",
      }),
      this.client.createPayloadIndex(this.collection, {
        field_name: "status",
        field_schema: "keyword",
      }),
      this.client.createPayloadIndex(this.collection, {
        field_name: "created_at",
        field_schema: "integer",
      }),
      this.client.createPayloadIndex(this.collection, {
        field_name: "conversation_id",
        field_schema: "keyword",
      }),
      this.client.createPayloadIndex(this.collection, {
        field_name: "modality",
        field_schema: "keyword",
      }),
      this.client.createPayloadIndex(this.collection, {
        field_name: "memory_scope_id",
        field_schema: "keyword",
      }),
    ]);
  }

  private async readSentinel(): Promise<string | null> {
    try {
      const points = await this.client.retrieve(this.collection, {
        ids: [this.SENTINEL_ID],
        with_payload: true,
        with_vector: false,
      });
      if (points.length === 0) return null;
      return (
        ((points[0].payload as Record<string, unknown>)
          ?.embedding_model as string) ?? null
      );
    } catch {
      return null;
    }
  }

  private async writeSentinel(model: string): Promise<void> {
    await this.client.upsert(this.collection, {
      wait: true,
      points: [
        {
          id: this.SENTINEL_ID,
          vector: {
            dense: new Array(this.vectorSize).fill(0), // zero vector, never matched in search
          },
          payload: { _meta: true, embedding_model: model },
        },
      ],
    });
  }

  private async findByTarget(
    targetType: string,
    targetId: string,
  ): Promise<string | null> {
    try {
      const results = await this.client.scroll(this.collection, {
        filter: {
          must: [
            { key: "target_type", match: { value: targetType } },
            { key: "target_id", match: { value: targetId } },
          ],
        },
        limit: 1,
        with_payload: false,
        with_vector: false,
      });
      if (results.points.length > 0) {
        const id = results.points[0].id;
        return typeof id === "string" ? id : String(id);
      }
    } catch {
      // Not found
    }
    return null;
  }
}
