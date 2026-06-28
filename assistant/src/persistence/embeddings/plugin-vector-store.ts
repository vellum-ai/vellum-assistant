/**
 * Generic, plugin-namespaced dense-vector store over Qdrant.
 *
 * The memory feature's {@link VellumQdrantClient} is bound to one collection
 * and carries a memory-specific payload schema (`target_type`, sentinels,
 * named dense+sparse vectors). Plugins need a neutral surface: a collection
 * they own, addressed by their own ids, carrying an opaque payload. This
 * module provides exactly that, sharing only the URL-resolution helper
 * (`resolveQdrantUrl`, which honours `QDRANT_HTTP_PORT`) with the memory
 * client so port allocation stays consistent across the process.
 */

import { QdrantClient as QdrantRestClient } from "@qdrant/js-client-rest";

import { getConfig } from "../../config/loader.js";
import { getLogger } from "../../util/logger.js";
import { resolveQdrantUrl } from "./qdrant-client.js";

const log = getLogger("plugin-vector-store");

/** A single dense-vector point. */
export interface PluginVectorPoint {
  id: string;
  vector: number[];
  payload?: Record<string, unknown>;
}

/** A search hit, ordered most-similar first. */
export interface PluginVectorSearchResult {
  id: string;
  score: number;
  payload: Record<string, unknown>;
}

/**
 * Build the Qdrant collection name for a plugin-owned vector store. Namespaced
 * by `hostId` so two plugins using the same logical `name` never collide.
 */
export function pluginCollectionName(hostId: string, name: string): string {
  return `plugin_${hostId}_${name}`;
}

/**
 * A handle to one plugin-owned Qdrant collection. Lazily creates the
 * collection on first write/read.
 */
export class PluginVectorCollection {
  private readonly client: QdrantRestClient;
  private readonly collection: string;
  private readonly vectorSize: number;
  private ready = false;

  constructor(args: { url: string; collection: string; vectorSize: number }) {
    this.client = new QdrantRestClient({
      url: args.url,
      checkCompatibility: false,
    });
    this.collection = args.collection;
    this.vectorSize = args.vectorSize;
  }

  /**
   * Provision the underlying collection if it does not yet exist. Idempotent
   * and safe to call before any read/write; exposed so the IPC vector-store
   * route can provision a collection deterministically (with the caller's
   * `vectorSize`) on `host.vectorStore.ensure`, before later op frames that
   * carry only the collection name.
   */
  async ensure(): Promise<void> {
    await this.ensureCollection();
  }

  private async ensureCollection(): Promise<void> {
    if (this.ready) return;
    try {
      const exists = await this.client.collectionExists(this.collection);
      if (!exists.exists) {
        await this.client.createCollection(this.collection, {
          vectors: { size: this.vectorSize, distance: "Cosine" },
        });
      }
    } catch (err) {
      // 409 = a concurrent caller created it first — that's fine.
      if (
        !(
          err instanceof Error &&
          "status" in err &&
          (err as { status: number }).status === 409
        )
      ) {
        throw err;
      }
    }
    this.ready = true;
  }

  async upsert(points: PluginVectorPoint[]): Promise<void> {
    if (points.length === 0) return;
    await this.ensureCollection();
    await this.client.upsert(this.collection, {
      wait: true,
      points: points.map((p) => ({
        id: p.id,
        vector: p.vector,
        payload: p.payload ?? {},
      })),
    });
  }

  async search(
    vector: number[],
    limit: number,
  ): Promise<PluginVectorSearchResult[]> {
    await this.ensureCollection();
    const results = await this.client.search(this.collection, {
      vector,
      limit,
      with_payload: true,
    });
    return results.map((r) => ({
      id: typeof r.id === "string" ? r.id : String(r.id),
      score: r.score,
      payload: (r.payload ?? {}) as Record<string, unknown>,
    }));
  }

  async delete(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.ensureCollection();
    await this.client.delete(this.collection, {
      wait: true,
      points: ids,
    });
  }
}

/**
 * Open (or lazily create) a plugin-namespaced vector collection. The Qdrant
 * URL is resolved per-process via {@link resolveQdrantUrl}, which prefers
 * `QDRANT_HTTP_PORT` so multi-local instances each talk to their own sidecar.
 */
export function openPluginVectorCollection(
  hostId: string,
  name: string,
  vectorSize: number,
): PluginVectorCollection {
  const collection = pluginCollectionName(hostId, name);
  const url = resolveQdrantUrl(getConfig());
  log.debug({ hostId, collection, vectorSize }, "Opening plugin vector store");
  return new PluginVectorCollection({ url, collection, vectorSize });
}
