import type { EmbeddingBackend, EmbeddingRequestOptions } from './embedding-backend.js';

interface OllamaEmbeddingsResponse {
  data?: Array<{ embedding: number[] }>;
  embeddings?: number[][];
}

const DEFAULT_OLLAMA_BASE_URL = 'http://127.0.0.1:11434/v1';

export class OllamaEmbeddingBackend implements EmbeddingBackend {
  readonly provider = 'ollama' as const;
  readonly model: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(model: string, options?: { baseUrl?: string; apiKey?: string }) {
    this.model = model;
    this.baseUrl = resolveBaseUrl(options?.baseUrl);
    this.apiKey = options?.apiKey ?? 'ollama';
  }

  async embed(texts: string[], options?: EmbeddingRequestOptions): Promise<number[][]> {
    if (texts.length === 0) return [];
    const response = await fetch(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        input: texts,
      }),
      signal: options?.signal,
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Ollama embeddings request failed (${response.status}): ${body}`);
    }
    const payload = await response.json() as OllamaEmbeddingsResponse;
    if (Array.isArray(payload.data)) {
      return payload.data.map((item) => item.embedding);
    }
    if (Array.isArray(payload.embeddings)) {
      return payload.embeddings;
    }
    throw new Error('Ollama embeddings response missing vectors');
  }
}

function resolveBaseUrl(override?: string): string {
  const value = (override ?? process.env.OLLAMA_BASE_URL ?? DEFAULT_OLLAMA_BASE_URL).trim();
  if (value.endsWith('/')) return value.slice(0, -1);
  return value;
}
