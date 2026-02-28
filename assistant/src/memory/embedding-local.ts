import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { getLogger } from '../util/logger.js';
import { getEmbeddingModelsDir } from '../util/platform.js';
import { PromiseGuard } from '../util/promise-guard.js';
import type { EmbeddingBackend, EmbeddingRequestOptions } from './embedding-backend.js';
import { EmbeddingRuntimeManager } from './embedding-runtime-manager.js';

const log = getLogger('memory-embedding-local');

type FeatureExtractionPipeline = (
  texts: string | string[],
  options?: { pooling?: string; normalize?: boolean },
) => Promise<{ tolist: () => number[][] }>;

/**
 * Local embedding backend using @huggingface/transformers (ONNX Runtime).
 * Runs BAAI/bge-small-en-v1.5 locally — no API calls, no network required.
 *
 * The embedding runtime (onnxruntime-node + transformers) is downloaded
 * post-hatch by EmbeddingRuntimeManager. Model weights are downloaded on first
 * use and cached in ~/.vellum/workspace/embedding-models/model-cache/.
 *
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

    // Resolution order:
    // 1. Post-hatch download: ~/.vellum/workspace/embedding-models/
    //    Downloaded by EmbeddingRuntimeManager after daemon startup.
    //    If the download is still in progress, wait for it to complete.
    // 2. Legacy bundled: execDir/node_modules/onnxruntime-node/dist/
    //    For backward compat with builds that still bundle in the .app.
    // 3. Dev mode: bare @huggingface/transformers import
    //    Works when running via `bun run` with packages installed.

    let transformers: typeof import('@huggingface/transformers') | undefined;

    // 1. Post-hatch downloaded runtime — wait for download if in progress
    const embeddingModelsDir = getEmbeddingModelsDir();
    const runtimeManager = new EmbeddingRuntimeManager();
    if (!runtimeManager.isReady()) {
      log.info('Embedding runtime not yet available, waiting for download...');
      try {
        await runtimeManager.ensureInstalled();
      } catch (err) {
        log.warn({ err }, 'Embedding runtime download failed during initialization');
      }
    }

    const wrapperPath = runtimeManager.getWrapperPath();
    if (existsSync(wrapperPath)) {
      try {
        transformers = await import(wrapperPath);
      } catch (err) {
        log.warn({ err }, 'Failed to load downloaded embedding runtime, trying fallbacks');
      }
    }

    // 2. Legacy bundled path (in .app bundle next to daemon binary)
    if (!transformers) {
      const execDir = dirname(process.execPath);
      const bundlePath = join(execDir, 'node_modules', 'onnxruntime-node', 'dist', 'transformers-bundle.mjs');
      try {
        transformers = await import(bundlePath);
      } catch {
        // Not available — try dev mode
      }
    }

    // 3. Dev mode fallback (bare specifier, works with bun run)
    // String concatenation prevents Bun from bundling this at compile time.
    if (!transformers) {
      try {
        const specifier = '@huggingface' + '/transformers';
        transformers = await import(specifier);
      } catch (err) {
        throw new Error(
          `Local embedding backend unavailable: failed to load @huggingface/transformers (${err instanceof Error ? err.message : String(err)})`,
        );
      }
    }

    // Point model weights cache to a stable location under the embedding
    // models directory instead of the default ~/.cache/huggingface/
    const modelCacheDir = join(embeddingModelsDir, 'model-cache');
    if ('env' in transformers! && transformers!.env) {
      (transformers!.env as { cacheDir?: string }).cacheDir = modelCacheDir;
    }

    this.extractor = await transformers!.pipeline('feature-extraction', this.model, {
      dtype: 'fp32',
    }) as unknown as FeatureExtractionPipeline;
    log.info({ model: this.model }, 'Local embedding model loaded');
  }
}
