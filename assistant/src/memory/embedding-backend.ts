import type { AssistantConfig } from '../config/types.js';
import { getLogger } from '../util/logger.js';
import { GeminiEmbeddingBackend } from './embedding-gemini.js';
import { OllamaEmbeddingBackend } from './embedding-ollama.js';
import { OpenAIEmbeddingBackend } from './embedding-openai.js';

const log = getLogger('memory-embeddings');

export type EmbeddingProviderName = 'openai' | 'gemini' | 'ollama';

export interface EmbeddingBackend {
  readonly provider: EmbeddingProviderName;
  readonly model: string;
  embed(texts: string[]): Promise<number[][]>;
}

export interface EmbeddingBackendSelection {
  backend: EmbeddingBackend | null;
  reason: string | null;
}

export function selectEmbeddingBackend(config: AssistantConfig): EmbeddingBackendSelection {
  const requested = config.memory.embeddings.provider;
  if (requested === 'ollama') {
    return {
      backend: new OllamaEmbeddingBackend(config.memory.embeddings.ollamaModel, {
        apiKey: config.apiKeys.ollama,
      }),
      reason: null,
    };
  }
  const order: EmbeddingProviderName[] = requested === 'auto'
    ? ['openai', 'gemini', 'ollama']
    : [requested];

  for (const provider of order) {
    switch (provider) {
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
    ? 'No embedding backend configured (openai/gemini keys missing and ollama not configured)'
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
): Promise<{
  provider: EmbeddingProviderName;
  model: string;
  vectors: number[][];
}> {
  const selection = selectEmbeddingBackend(config);
  if (!selection.backend) {
    throw new Error(selection.reason ?? 'No memory embedding backend configured');
  }
  const vectors = await selection.backend.embed(texts);
  if (vectors.length !== texts.length) {
    throw new Error(`Embedding backend returned ${vectors.length} vectors for ${texts.length} texts`);
  }
  return {
    provider: selection.backend.provider,
    model: selection.backend.model,
    vectors,
  };
}

export function logMemoryEmbeddingWarning(err: unknown, context: string): void {
  log.warn({ err }, `Memory embeddings failed (${context})`);
}

function isOllamaConfigured(config: AssistantConfig): boolean {
  return config.provider === 'ollama'
    || Boolean(config.apiKeys.ollama)
    || Boolean(process.env.OLLAMA_BASE_URL);
}
