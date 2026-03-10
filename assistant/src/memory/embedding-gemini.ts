import type {
  EmbeddingBackend,
  EmbeddingInput,
  EmbeddingRequestOptions,
} from "./embedding-backend.js";
import { normalizeEmbeddingInput } from "./embedding-types.js";

interface GeminiEmbedResponse {
  embedding?: {
    values?: number[];
  };
}

export class GeminiEmbeddingBackend implements EmbeddingBackend {
  readonly provider = "gemini" as const;
  readonly model: string;
  private readonly apiKey: string;

  constructor(apiKey: string, model: string) {
    this.apiKey = apiKey;
    this.model = model;
  }

  async embed(
    inputs: EmbeddingInput[],
    options?: EmbeddingRequestOptions,
  ): Promise<number[][]> {
    const vectors: number[][] = [];
    for (const input of inputs) {
      const values = await this.embedSingle(input, options);
      vectors.push(values);
    }
    return vectors;
  }

  private async embedSingle(
    input: EmbeddingInput,
    options?: EmbeddingRequestOptions,
  ): Promise<number[]> {
    const normalized = normalizeEmbeddingInput(input);
    if (normalized.type !== "text") {
      throw new Error(
        "Gemini embedding backend only supports text inputs (multimodal support coming soon)",
      );
    }
    const text = normalized.text;

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      this.model,
    )}:embedContent?key=${encodeURIComponent(this.apiKey)}`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: `models/${this.model}`,
        content: {
          parts: [{ text }],
        },
      }),
      signal: options?.signal,
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `Gemini embeddings request failed (${response.status}): ${body}`,
      );
    }
    const payload = (await response.json()) as GeminiEmbedResponse;
    const values = payload.embedding?.values;
    if (!Array.isArray(values) || values.length === 0) {
      throw new Error("Gemini embeddings response missing vector values");
    }
    return values;
  }
}
