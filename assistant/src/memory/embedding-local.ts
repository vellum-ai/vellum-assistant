import type { EmbeddingBackend, EmbeddingRequestOptions } from './embedding-backend.js';
import { getLogger } from '../util/logger.js';
import { PromiseGuard } from '../util/promise-guard.js';

const log = getLogger('memory-embedding-local');

type FeatureExtractionPipeline = (
  texts: string | string[],
  options?: { pooling?: string; normalize?: boolean },
) => Promise<{ tolist: () => number[][] }>;

/**
 * Local embedding backend using @huggingface/transformers (ONNX Runtime).
 * Runs BAAI/bge-small-en-v1.5 locally — no API calls, no network required.
 *
 * The model is downloaded on first use and cached by the transformers library.
 * Produces 384-dimensional embeddings.
 */
export class LocalEmbeddingBackend implements EmbeddingBackend {
  readonly provider = 'local' as const;
  readonly model: string;
  private extractor: FeatureExtractionPipeline | null = null;
  private readonly initGuard = new PromiseGuard<void>();

  constructor(model: string) {
    this.model = model;
  }

  async embed(texts: string[], options?: EmbeddingRequestOptions): Promise<number[][]> {
    if (texts.length === 0) return [];
    if (options?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    await this.ensureInitialized();

    const results: number[][] = [];
    // Process in batches of 32 to avoid OOM with large inputs
    const batchSize = 32;
    for (let i = 0; i < texts.length; i += batchSize) {
      if (options?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const batch = texts.slice(i, i + batchSize);
      const output = await this.extractor!(batch, {
        pooling: 'cls',
        normalize: true,
      });
      const vectors = output.tolist();
      results.push(...vectors);
    }

    return results;
  }

  private async ensureInitialized(): Promise<void> {
    if (this.extractor) return;
    await this.initGuard.run(() => this.initialize());
  }

  private async initialize(): Promise<void> {
    log.info({ model: this.model }, 'Loading local embedding model (first load downloads the model)');
    const { pipeline } = await import('@huggingface/transformers');
    this.extractor = await pipeline('feature-extraction', this.model, {
      dtype: 'fp32',
    }) as unknown as FeatureExtractionPipeline;
    log.info({ model: this.model }, 'Local embedding model loaded');
  }
}
