import OpenAI from 'openai';
import type { EmbeddingBackend } from './embedding-backend.js';

export class OpenAIEmbeddingBackend implements EmbeddingBackend {
  readonly provider = 'openai' as const;
  readonly model: string;
  private readonly client: OpenAI;

  constructor(apiKey: string, model: string) {
    this.model = model;
    this.client = new OpenAI({ apiKey });
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const response = await this.client.embeddings.create({
      model: this.model,
      input: texts,
      encoding_format: 'float',
    });
    return response.data.map((item) => item.embedding);
  }
}
