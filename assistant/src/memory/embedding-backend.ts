import type { AssistantConfig } from '../config/types.js';
import { getLogger } from '../util/logger.js';
import { GeminiEmbeddingBackend } from './embedding-gemini.js';
import { LocalEmbeddingBackend } from './embedding-local.js';
import { OllamaEmbeddingBackend } from './embedding-ollama.js';
import { OpenAIEmbeddingBackend } from './embedding-openai.js';

const log = getLogger('memory-embeddings');

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
      backend: new LocalEmbeddingBackend(config.memory.embeddings.localModel),
      reason: null,
    };
  }
  if (requested === 'ollama') {
    return {
      backend: new OllamaEmbeddingBackend(config.memory.embeddings.ollamaModel, {
        apiKey: config.apiKeys.ollama,
      }),
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
          backend: new LocalEmbeddingBackend(config.memory.embeddings.localModel),
          reason: null,
        };
      case 'openai':
        if (!config.apiKeys.openai) continue;
        return {
          backend: new OpenAIEmbeddingBackend(config.apiKeys.openai, config.memory.embeddings.openaiModel),
          reason: null,
        };
      case 'gemini':
        if (!config.apiKeys.gemini) continue;
        return {
          backend: new GeminiEmbeddingBackend(config.apiKeys.gemini, config.memory.embeddings.geminiModel),
          reason: null,
        };
      case 'ollama':
        if (!isOllamaConfigured(config)) continue;
        return {
          backend: new OllamaEmbeddingBackend(config.memory.embeddings.ollamaModel, {
            apiKey: config.apiKeys.ollama,
          }),
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

  // In auto mode, build a fallback list of backends to try
  const backends: EmbeddingBackend[] = [selection.backend];
  if (config.memory.embeddings.provider === 'auto' && selection.backend.provider === 'local') {
    for (const fallback of selectFallbackBackends(config, 'local')) {
      backends.push(fallback);
    }
  }

  let lastErr: unknown;
  for (const backend of backends) {
    try {
      const vectors = await backend.embed(texts, options);
      if (vectors.length !== texts.length) {
        throw new Error(`Embedding backend returned ${vectors.length} vectors for ${texts.length} texts`);
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
          backends.push(new OpenAIEmbeddingBackend(config.apiKeys.openai, config.memory.embeddings.openaiModel));
        }
        break;
      case 'gemini':
        if (config.apiKeys.gemini) {
          backends.push(new GeminiEmbeddingBackend(config.apiKeys.gemini, config.memory.embeddings.geminiModel));
        }
        break;
      case 'ollama':
        if (isOllamaConfigured(config)) {
          backends.push(new OllamaEmbeddingBackend(config.memory.embeddings.ollamaModel, {
            apiKey: config.apiKeys.ollama,
          }));
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
