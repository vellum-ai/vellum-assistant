import { QdrantClient as QdrantRestClient } from '@qdrant/js-client-rest';
import { v4 as uuid } from 'uuid';
import { getLogger } from '../util/logger.js';

const log = getLogger('qdrant-client');

export interface QdrantClientConfig {
  url: string;
  collection: string;
  vectorSize: number;
  onDisk: boolean;
  quantization: 'scalar' | 'none';
}

export interface QdrantPointPayload {
  target_type: 'segment' | 'item' | 'summary';
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
  entity_ids?: string[];
}

export interface QdrantSearchResult {
  id: string;
  score: number;
  payload: QdrantPointPayload;
}

let _instance: VellumQdrantClient | null = null;

export function getQdrantClient(): VellumQdrantClient {
  if (!_instance) {
    throw new Error('Qdrant client not initialized. Call initQdrantClient() first.');
  }
  return _instance;
}

export function initQdrantClient(config: QdrantClientConfig): VellumQdrantClient {
  _instance = new VellumQdrantClient(config);
  return _instance;
}

export class VellumQdrantClient {
  private readonly client: QdrantRestClient;
  private readonly collection: string;
  private readonly vectorSize: number;
  private readonly onDisk: boolean;
  private readonly quantization: 'scalar' | 'none';
  private collectionReady = false;

  constructor(config: QdrantClientConfig) {
    this.client = new QdrantRestClient({ url: config.url });
    this.collection = config.collection;
    this.vectorSize = config.vectorSize;
    this.onDisk = config.onDisk;
    this.quantization = config.quantization;
  }

  async ensureCollection(): Promise<void> {
    if (this.collectionReady) return;

    try {
      const exists = await this.client.collectionExists(this.collection);
      if (exists.exists) {
        this.collectionReady = true;
        return;
      }
    } catch {
      // Collection doesn't exist, create it
    }

    log.info({ collection: this.collection, vectorSize: this.vectorSize }, 'Creating Qdrant collection');

    await this.client.createCollection(this.collection, {
      vectors: {
        size: this.vectorSize,
        distance: 'Cosine',
        on_disk: this.onDisk,
      },
      hnsw_config: {
        on_disk: this.onDisk,
        m: 16,
        ef_construct: 100,
      },
      quantization_config: this.quantization === 'scalar'
        ? {
          scalar: {
            type: 'int8',
            quantile: 0.99,
            always_ram: true,
          },
        }
        : undefined,
      on_disk_payload: this.onDisk,
    });

    // Create payload indexes for efficient filtering
    await Promise.all([
      this.client.createPayloadIndex(this.collection, {
        field_name: 'target_type',
        field_schema: 'keyword',
      }),
      this.client.createPayloadIndex(this.collection, {
        field_name: 'target_id',
        field_schema: 'keyword',
      }),
      this.client.createPayloadIndex(this.collection, {
        field_name: 'kind',
        field_schema: 'keyword',
      }),
      this.client.createPayloadIndex(this.collection, {
        field_name: 'status',
        field_schema: 'keyword',
      }),
      this.client.createPayloadIndex(this.collection, {
        field_name: 'created_at',
        field_schema: 'integer',
      }),
      this.client.createPayloadIndex(this.collection, {
        field_name: 'conversation_id',
        field_schema: 'keyword',
      }),
    ]);

    this.collectionReady = true;
    log.info({ collection: this.collection }, 'Qdrant collection created with payload indexes');
  }

  async upsert(
    targetType: 'segment' | 'item' | 'summary',
    targetId: string,
    vector: number[],
    payload: Omit<QdrantPointPayload, 'target_type' | 'target_id'>,
  ): Promise<string> {
    await this.ensureCollection();

    // Deterministic point ID: look up existing point by target_type + target_id
    const existing = await this.findByTarget(targetType, targetId);
    const pointId = existing ?? uuid();

    await this.client.upsert(this.collection, {
      wait: true,
      points: [
        {
          id: pointId,
          vector,
          payload: {
            target_type: targetType,
            target_id: targetId,
            ...payload,
          },
        },
      ],
    });

    return pointId;
  }

  async search(
    vector: number[],
    limit: number,
    filter?: Record<string, unknown>,
  ): Promise<QdrantSearchResult[]> {
    await this.ensureCollection();

    const results = await this.client.search(this.collection, {
      vector,
      limit,
      with_payload: true,
      score_threshold: 0.0,
      filter: filter as Parameters<QdrantRestClient['search']>[1]['filter'],
    });

    return results.map((result) => ({
      id: typeof result.id === 'string' ? result.id : String(result.id),
      score: result.score,
      payload: result.payload as unknown as QdrantPointPayload,
    }));
  }

  async searchWithFilter(
    vector: number[],
    limit: number,
    targetTypes: Array<'segment' | 'item' | 'summary'>,
    excludeMessageIds?: string[],
  ): Promise<QdrantSearchResult[]> {
    const mustConditions: Array<Record<string, unknown>> = [
      {
        key: 'target_type',
        match: { any: targetTypes },
      },
    ];

    if (excludeMessageIds && excludeMessageIds.length > 0) {
      // Only require status=active for items; segments and summaries don't have a status field
      mustConditions.push({
        should: [
          {
            must: [
              { key: 'target_type', match: { value: 'item' } },
              { key: 'status', match: { value: 'active' } },
            ],
          },
          { key: 'target_type', match: { any: ['segment', 'summary'] } },
        ],
      });
    }

    const mustNotConditions: Array<Record<string, unknown>> = [];
    if (excludeMessageIds && excludeMessageIds.length > 0) {
      mustNotConditions.push({
        key: 'message_id',
        match: { any: excludeMessageIds },
      });
    }

    const filter: Record<string, unknown> = {
      must: mustConditions,
    };
    if (mustNotConditions.length > 0) {
      filter.must_not = mustNotConditions;
    }

    return this.search(vector, limit, filter);
  }

  async deleteByTarget(targetType: string, targetId: string): Promise<void> {
    await this.ensureCollection();

    await this.client.delete(this.collection, {
      wait: true,
      filter: {
        must: [
          { key: 'target_type', match: { value: targetType } },
          { key: 'target_id', match: { value: targetId } },
        ],
      },
    });
  }

  async count(): Promise<number> {
    await this.ensureCollection();
    const result = await this.client.count(this.collection, { exact: false });
    return result.count;
  }

  private async findByTarget(targetType: string, targetId: string): Promise<string | null> {
    try {
      const results = await this.client.scroll(this.collection, {
        filter: {
          must: [
            { key: 'target_type', match: { value: targetType } },
            { key: 'target_id', match: { value: targetId } },
          ],
        },
        limit: 1,
        with_payload: false,
        with_vector: false,
      });
      if (results.points.length > 0) {
        const id = results.points[0].id;
        return typeof id === 'string' ? id : String(id);
      }
    } catch {
      // Not found
    }
    return null;
  }
}
