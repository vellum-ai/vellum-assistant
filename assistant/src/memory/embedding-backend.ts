import { createHash } from 'node:crypto';
import type { AssistantConfig } from '../config/types.js';
import { getLogger } from '../util/logger.js';
import { GeminiEmbeddingBackend } from './embedding-gemini.js';
import { LocalEmbeddingBackend } from './embedding-local.js';
import { OllamaEmbeddingBackend } from './embedding-ollama.js';
import { OpenAIEmbeddingBackend } from './embedding-openai.js';

const log = getLogger('memory-embeddings');

/** Global cache of embedding backend instances, keyed by "provider:model". */
const backendCache = new Map<string, EmbeddingBackend>();

// ── In-memory embedding vector cache ──────────────────────────────
// LRU cache keyed by sha256(provider + model + text) → embedding vector.
// Avoids redundant API calls / local compute for identical content.
const VECTOR_CACHE_MAX_ENTRIES = 4096;
const vectorCache = new Map<string, number[]>();

function vectorCacheKey(provider: string, model: string, text: string): string {
  return createHash('sha256').update(`${provider}\0${model}\0${text}`).digest('hex');
}

function getFromVectorCache(provider: string, model: string, text: string): number[] | undefined {
  const key = vectorCacheKey(provider, model, text);
  const v = vectorCache.get(key);
  if (v !== undefined) {
    // LRU refresh: move to end of insertion order
    vectorCache.delete(key);
    vectorCache.set(key, v);
  }
  return v;
}

function putInVectorCache(provider: string, model: string, text: string, vector: number[]): void {
  const key = vectorCacheKey(provider, model, text);
  vectorCache.delete(key);
  if (vectorCache.size >= VECTOR_CACHE_MAX_ENTRIES) {
    const oldest = vectorCache.keys().next().value;
    if (oldest !== undefined) vectorCache.delete(oldest);
  }
  vectorCache.set(key, vector);
}

/** Clear cached embedding backends and the in-memory vector cache. */
export function clearEmbeddingBackendCache(): void {
  backendCache.clear();
  vectorCache.clear();
}

function cacheKey(provider: string, model: string): string {
  return `${provider}:${model}`;
}

function getCachedOrCreate<T extends EmbeddingBackend>(provider: string, model: string, create: () => T): T {
  const key = cacheKey(provider, model);
  const existing = backendCache.get(key);
  if (existing) return existing as T;
  const instance = create();
  backendCache.set(key, instance);
  return instance;
}

export type EmbeddingProviderName = 'local' | 'openai' | 'gemini' | 'ollama';

export interface EmbeddingRequestOptions {
  signal?: AbortSignal;
}

export interface EmbeddingBackend {
  readonly provider: EmbeddingProviderName;
  readonly model: string;
  embed(texts: string[], options?: EmbeddingRequestOptions): Promise<number[][]>;
}

export interface EmbeddingBackendSelection {
  backend: EmbeddingBackend | null;
  reason: string | null;
}

export function selectEmbeddingBackend(config: AssistantConfig): EmbeddingBackendSelection {
  const requested = config.memory.embeddings.provider;
  if (requested === 'local') {
    return {
      backend: getCachedOrCreate('local', config.memory.embeddings.localModel,
        () => new LocalEmbeddingBackend(config.memory.embeddings.localModel)),
      reason: null,
    };
  }
  if (requested === 'ollama') {
    return {
      backend: getCachedOrCreate('ollama', config.memory.embeddings.ollamaModel,
        () => new OllamaEmbeddingBackend(config.memory.embeddings.ollamaModel, {
          apiKey: config.apiKeys.ollama,
        })),
      reason: null,
    };
  }

  // Auto order: local → openai → gemini → ollama
  const order: EmbeddingProviderName[] = requested === 'auto'
    ? ['local', 'openai', 'gemini', 'ollama']
    : [requested];

  for (const provider of order) {
    switch (provider) {
      case 'local':
        // Local embeddings are always available (model downloaded on first use)
        return {
          backend: getCachedOrCreate('local', config.memory.embeddings.localModel,
            () => new LocalEmbeddingBackend(config.memory.embeddings.localModel)),
          reason: null,
        };
      case 'openai':
        if (!config.apiKeys.openai) continue;
        return {
          backend: getCachedOrCreate('openai', config.memory.embeddings.openaiModel,
            () => new OpenAIEmbeddingBackend(config.apiKeys.openai, config.memory.embeddings.openaiModel)),
          reason: null,
        };
      case 'gemini':
        if (!config.apiKeys.gemini) continue;
        return {
          backend: getCachedOrCreate('gemini', config.memory.embeddings.geminiModel,
            () => new GeminiEmbeddingBackend(config.apiKeys.gemini, config.memory.embeddings.geminiModel)),
          reason: null,
        };
      case 'ollama':
        if (!isOllamaConfigured(config)) continue;
        return {
          backend: getCachedOrCreate('ollama', config.memory.embeddings.ollamaModel,
            () => new OllamaEmbeddingBackend(config.memory.embeddings.ollamaModel, {
              apiKey: config.apiKeys.ollama,
            })),
          reason: null,
        };
    }
  }

  const reason = requested === 'auto'
    ? 'No embedding backend configured'
    : `Embedding backend "${requested}" is not configured`;
  return { backend: null, reason };
}

export function getMemoryBackendStatus(config: AssistantConfig): {
  enabled: boolean;
  degraded: boolean;
  provider: EmbeddingProviderName | null;
  model: string | null;
  reason: string | null;
} {
  if (!config.memory.enabled) {
    return { enabled: false, degraded: false, provider: null, model: null, reason: 'memory.disabled' };
  }
  const selection = selectEmbeddingBackend(config);
  if (!selection.backend) {
    return {
      enabled: true,
      degraded: config.memory.embeddings.required,
      provider: null,
      model: null,
      reason: selection.reason,
    };
  }
  return {
    enabled: true,
    degraded: false,
    provider: selection.backend.provider,
    model: selection.backend.model,
    reason: null,
  };
}

export async function embedWithBackend(
  config: AssistantConfig,
  texts: string[],
  options?: EmbeddingRequestOptions,
): Promise<{
  provider: EmbeddingProviderName;
  model: string;
  vectors: number[][];
}> {
  const selection = selectEmbeddingBackend(config);
  if (!selection.backend) {
    throw new Error(selection.reason ?? 'No memory embedding backend configured');
  }

  const expectedDim = config.memory.qdrant.vectorSize;
  const { provider: primaryProvider, model: primaryModel } = selection.backend;

  // ── In-memory cache check ───────────────────────────────────────
  const cached: (number[] | null)[] = texts.map(t => {
    const v = getFromVectorCache(primaryProvider, primaryModel, t);
    return v && v.length === expectedDim ? v : null;
  });
  const uncachedIndices: number[] = [];
  for (let i = 0; i < cached.length; i++) {
    if (!cached[i]) uncachedIndices.push(i);
  }
  if (uncachedIndices.length === 0) {
    return { provider: primaryProvider, model: primaryModel, vectors: cached as number[][] };
  }

  // ── Embed uncached texts ────────────────────────────────────────
  const backends: EmbeddingBackend[] = [selection.backend];
  if (config.memory.embeddings.provider === 'auto' && selection.backend.provider === 'local') {
    for (const fallback of selectFallbackBackends(config, 'local')) {
      backends.push(fallback);
    }
  }

  let lastErr: unknown;
  for (const backend of backends) {
    const isPrimary = backend === selection.backend;
    // For the primary backend, only embed uncached texts and merge with cached.
    // For fallback backends, embed ALL texts since the cache was keyed to the primary.
    const textsToEmbed = isPrimary ? uncachedIndices.map(i => texts[i]) : texts;

    try {
      const vectors = await backend.embed(textsToEmbed, options);
      if (vectors.length !== textsToEmbed.length) {
        throw new Error(`Embedding backend returned ${vectors.length} vectors for ${textsToEmbed.length} texts`);
      }
      for (const vec of vectors) {
        if (vec.length !== expectedDim) {
          throw new Error(
            `Embedding backend "${backend.provider}" (model ${backend.model}) returned vectors of dimension ${vec.length}, but Qdrant collection expects ${expectedDim}`,
          );
        }
      }

      // Populate cache with freshly embedded vectors
      for (let i = 0; i < textsToEmbed.length; i++) {
        putInVectorCache(backend.provider, backend.model, textsToEmbed[i], vectors[i]);
      }

      if (isPrimary) {
        const merged = [...cached] as number[][];
        for (let i = 0; i < uncachedIndices.length; i++) {
          merged[uncachedIndices[i]] = vectors[i];
        }
        return { provider: backend.provider, model: backend.model, vectors: merged };
      }
      return { provider: backend.provider, model: backend.model, vectors };
    } catch (err) {
      lastErr = err;
      if (backends.length > 1) {
        log.warn({ err, provider: backend.provider }, 'Embedding backend failed, trying next');
      }
    }
  }
  throw lastErr;
}

export function logMemoryEmbeddingWarning(err: unknown, context: string): void {
  log.warn({ err }, `Memory embeddings failed (${context})`);
}

function selectFallbackBackends(config: AssistantConfig, exclude: EmbeddingProviderName): EmbeddingBackend[] {
  const backends: EmbeddingBackend[] = [];
  const order: EmbeddingProviderName[] = ['openai', 'gemini', 'ollama'];
  for (const provider of order) {
    if (provider === exclude) continue;
    switch (provider) {
      case 'openai':
        if (config.apiKeys.openai) {
          backends.push(getCachedOrCreate('openai', config.memory.embeddings.openaiModel,
            () => new OpenAIEmbeddingBackend(config.apiKeys.openai, config.memory.embeddings.openaiModel)));
        }
        break;
      case 'gemini':
        if (config.apiKeys.gemini) {
          backends.push(getCachedOrCreate('gemini', config.memory.embeddings.geminiModel,
            () => new GeminiEmbeddingBackend(config.apiKeys.gemini, config.memory.embeddings.geminiModel)));
        }
        break;
      case 'ollama':
        if (isOllamaConfigured(config)) {
          backends.push(getCachedOrCreate('ollama', config.memory.embeddings.ollamaModel,
            () => new OllamaEmbeddingBackend(config.memory.embeddings.ollamaModel, {
              apiKey: config.apiKeys.ollama,
            })));
        }
        break;
    }
  }
  return backends;
}

function isOllamaConfigured(config: AssistantConfig): boolean {
  return config.provider === 'ollama'
    || Boolean(config.apiKeys.ollama)
    || Boolean(process.env.OLLAMA_BASE_URL);
}
