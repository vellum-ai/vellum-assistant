import { QdrantClient as QdrantRestClient } from "@qdrant/js-client-rest";
import { v5 as uuidv5 } from "uuid";

import { getLogger } from "../../util/logger.js";
import type { SparseEmbedding } from "./embedding-types.js";

const log = getLogger("messages-lexical-index");

/**
 * Dedicated Qdrant collection holding the lexical (BM25-style sparse) index for
 * `messages`. Sparse-only — there is no dense vector. The collection is a
 * faithful replacement for SQLite FTS5 full-text search over message content,
 * encoded with the local TF-IDF sparse encoder so no per-message model call is
 * required to index a message.
 */
export const MESSAGES_LEXICAL_COLLECTION = "messages_lexical";

/**
 * Stable namespace for deriving deterministic Qdrant point ids from message
 * ids. Using a fixed namespace (instead of `uuid.URL`) keeps point-id identity
 * scoped to this index, so the same `messageId` always maps to the same point
 * and re-indexing is idempotent without a pre-read.
 */
const MESSAGE_POINT_NAMESPACE = "b6d0d3e2-1f1a-4c3e-9a7c-0e2f5a8d4c11";

/**
 * Explicit segment count for the collection. Left unset, Qdrant sizes the
 * segment count to the node's CPU count, and each segment carries a fixed
 * storage preallocation — a small sparse-only collection then idles at
 * hundreds of MB. Matches the v2 concept-pages collection.
 */
const DEFAULT_SEGMENT_NUMBER = 2;

export interface MessagesLexicalIndexConfig {
  url: string;
  collection?: string;
  onDisk?: boolean;
}

export interface MessageLexicalPayload {
  messageId: string;
  conversationId: string;
  createdAt: number;
}

export interface MessageLexicalSearchResult {
  messageId: string;
  score: number;
}

let _instance: MessagesLexicalIndex | null = null;

export function getMessagesLexicalIndex(): MessagesLexicalIndex {
  if (!_instance) {
    throw new Error(
      "Messages lexical index not initialized. Call initMessagesLexicalIndex() first.",
    );
  }
  return _instance;
}

export function initMessagesLexicalIndex(
  config: MessagesLexicalIndexConfig,
): MessagesLexicalIndex {
  _instance = new MessagesLexicalIndex(config);
  return _instance;
}

/**
 * Derive the deterministic Qdrant point id for a message. Idempotent:
 * re-indexing the same `messageId` overwrites the same point.
 */
export function messagePointId(messageId: string): string {
  return uuidv5(messageId, MESSAGE_POINT_NAMESPACE);
}

export class MessagesLexicalIndex {
  private readonly client: QdrantRestClient;
  private readonly collection: string;
  private readonly onDisk: boolean;
  private collectionReady = false;

  constructor(config: MessagesLexicalIndexConfig) {
    this.client = new QdrantRestClient({
      url: config.url,
      checkCompatibility: false,
    });
    this.collection = config.collection ?? MESSAGES_LEXICAL_COLLECTION;
    this.onDisk = config.onDisk ?? true;
  }

  async ensureCollection(): Promise<void> {
    if (this.collectionReady) return;

    try {
      const exists = await this.client.collectionExists(this.collection);
      if (exists.exists) {
        await this.reconcileSparseIndexOnDisk();
        await this.reconcileSegmentNumber();
        if (await this.ensurePayloadIndexesSafe()) {
          this.collectionReady = true;
        }
        return;
      }
    } catch {
      // Existence check failed — fall through to creation.
    }

    log.info(
      { collection: this.collection },
      "Creating sparse-only Qdrant collection for messages lexical index",
    );

    try {
      await this.client.createCollection(this.collection, {
        // Sparse-only: no dense `vectors` config. The lexical index is a
        // BM25-style replacement for FTS5 and never holds a dense vector.
        sparse_vectors: {
          // The sparse inverted index lives in RAM unless placed on disk
          // explicitly. This index covers every message ever written, so its
          // RAM footprint grows without bound — keep it on disk alongside the
          // payloads.
          sparse: { index: { on_disk: this.onDisk } },
        },
        optimizers_config: {
          default_segment_number: DEFAULT_SEGMENT_NUMBER,
        },
        on_disk_payload: this.onDisk,
      });
    } catch (err) {
      // 409 = a concurrent caller created the collection first — that's fine.
      if (
        err instanceof Error &&
        "status" in err &&
        (err as { status: number }).status === 409
      ) {
        if (await this.ensurePayloadIndexesSafe()) {
          this.collectionReady = true;
        }
        return;
      }
      throw err;
    }

    if (await this.ensurePayloadIndexesSafe()) {
      this.collectionReady = true;
      log.info(
        { collection: this.collection },
        "Messages lexical index collection created with payload indexes",
      );
    }
  }

  async upsertMessage(
    messageId: string,
    sparse: SparseEmbedding,
    payload: { conversationId: string; createdAt: number },
  ): Promise<void> {
    await this.upsertMessagesBatch([
      {
        messageId,
        sparse,
        conversationId: payload.conversationId,
        createdAt: payload.createdAt,
      },
    ]);
  }

  async upsertMessagesBatch(
    points: Array<{
      messageId: string;
      sparse: SparseEmbedding;
      conversationId: string;
      createdAt: number;
    }>,
  ): Promise<void> {
    await this.ensureCollection();

    if (points.length === 0) return;

    const qdrantPoints = points.map((p) => ({
      id: messagePointId(p.messageId),
      vector: {
        sparse: {
          indices: p.sparse.indices,
          values: p.sparse.values,
        },
      },
      payload: {
        message_id: p.messageId,
        conversation_id: p.conversationId,
        created_at: p.createdAt,
      },
    }));

    const doUpsert = () =>
      this.client.upsert(this.collection, {
        wait: true,
        points: qdrantPoints,
      });

    try {
      await doUpsert();
    } catch (err) {
      if (this.isCollectionMissing(err)) {
        this.collectionReady = false;
        await this.ensureCollection();
        await doUpsert();
      } else {
        throw err;
      }
    }
  }

  async searchLexical(
    sparse: SparseEmbedding,
    limit: number,
    opts?: { conversationId?: string },
  ): Promise<MessageLexicalSearchResult[]> {
    await this.ensureCollection();

    const filter = opts?.conversationId
      ? {
          must: [
            {
              key: "conversation_id",
              match: { value: opts.conversationId },
            },
          ],
        }
      : undefined;

    const queryParams = {
      query: {
        indices: sparse.indices,
        values: sparse.values,
      },
      using: "sparse",
      limit,
      with_payload: true,
      filter: filter as Record<string, unknown> | undefined,
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
      messageId: String(
        (point.payload as Record<string, unknown> | undefined)?.message_id ??
          "",
      ),
      score: point.score ?? 0,
    }));
  }

  async deleteByMessageId(messageId: string): Promise<void> {
    await this.ensureCollection();

    // Delete by the deterministic point id rather than a `message_id` payload
    // filter: `message_id` has no payload index, so a filter delete would scan
    // the whole collection. The point id is recoverable from the message id.
    const doDelete = () =>
      this.client.delete(this.collection, {
        wait: true,
        points: [messagePointId(messageId)],
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

  async deleteByConversation(conversationId: string): Promise<void> {
    await this.ensureCollection();

    const doDelete = () =>
      this.client.delete(this.collection, {
        wait: true,
        filter: {
          must: [{ key: "conversation_id", match: { value: conversationId } }],
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

  /**
   * Remove every point from the index by dropping the whole collection. Used by
   * "clear all conversations" — a bulk wipe with no conversation ids left to
   * enqueue per-conversation purges against. Resetting `collectionReady` means
   * the next write self-heals via `ensureCollection`. Returns `false` (rather
   * than throwing) if the collection is absent or the drop fails, mirroring the
   * shared Qdrant client's `deleteCollection` so callers can treat it as
   * best-effort.
   */
  async clear(): Promise<boolean> {
    try {
      const exists = await this.client.collectionExists(this.collection);
      if (!exists.exists) {
        this.collectionReady = false;
        return false;
      }
      await this.client.deleteCollection(this.collection);
      this.collectionReady = false;
      return true;
    } catch (err) {
      log.warn(
        { err, collection: this.collection },
        "Failed to clear messages lexical index collection",
      );
      return false;
    }
  }

  /**
   * Align an existing collection's sparse-index placement with the configured
   * `onDisk` flag. Qdrant keeps the sparse inverted index in RAM unless the
   * collection explicitly opts into on-disk, and collections keep whatever
   * they were created with — for this index that means RAM usage growing with
   * every message ever written. `updateCollection` moves the index in place
   * (the optimizer rewrites segments in the background) with no re-encode.
   *
   * Best-effort: a failed probe or update logs and leaves the collection
   * serving from its current index — search keeps working either way.
   */
  private async reconcileSparseIndexOnDisk(): Promise<void> {
    try {
      const info = await this.client.getCollection(this.collection);
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
      if (!sparseParams || !("sparse" in sparseParams)) return;

      const current = sparseParams.sparse?.index?.on_disk ?? false;
      if (current === this.onDisk) return;

      await this.client.updateCollection(this.collection, {
        sparse_vectors: { sparse: { index: { on_disk: this.onDisk } } },
      });
      log.info(
        { collection: this.collection, onDisk: this.onDisk },
        "Moved sparse index placement on existing Qdrant collection",
      );
    } catch (err) {
      log.warn(
        { err, collection: this.collection, onDisk: this.onDisk },
        "Failed to update sparse index placement — continuing with current index",
      );
    }
  }

  /**
   * Align an existing collection's segment count with
   * {@link DEFAULT_SEGMENT_NUMBER}. A collection created without an explicit
   * count keeps Qdrant's CPU-count auto-detection (reported as unset/0);
   * `updateCollection` sets the target and the background optimizer merges
   * segments toward it in place.
   *
   * Best-effort: a failed probe or update logs and leaves the collection
   * serving with its current segments — search keeps working either way.
   */
  private async reconcileSegmentNumber(): Promise<void> {
    try {
      const info = await this.client.getCollection(this.collection);
      const current =
        (
          info.config as
            | {
                optimizer_config?: {
                  default_segment_number?: number | null;
                } | null;
              }
            | undefined
        )?.optimizer_config?.default_segment_number ?? 0;
      if (current === DEFAULT_SEGMENT_NUMBER) {
        return;
      }

      await this.client.updateCollection(this.collection, {
        optimizers_config: {
          default_segment_number: DEFAULT_SEGMENT_NUMBER,
        },
      });
      log.info(
        {
          collection: this.collection,
          from: current,
          to: DEFAULT_SEGMENT_NUMBER,
        },
        "Set explicit segment count on existing Qdrant collection",
      );
    } catch (err) {
      log.warn(
        { err, collection: this.collection },
        "Failed to update collection segment count — continuing with current segments",
      );
    }
  }

  /**
   * Detect "collection not found" errors from Qdrant so callers can reset
   * collectionReady and retry after an external deletion.
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
   * Wraps ensurePayloadIndexes so that a 404 (collection deleted between the
   * existence check and index creation) resets collectionReady instead of
   * propagating — the next operation self-heals via ensureCollection.
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
        field_name: "conversation_id",
        field_schema: "keyword",
      }),
      this.client.createPayloadIndex(this.collection, {
        field_name: "created_at",
        field_schema: "integer",
      }),
    ]);
  }
}
