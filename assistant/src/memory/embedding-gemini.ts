import type {
  EmbeddingBackend,
  EmbeddingInput,
  EmbeddingRequestOptions,
} from "./embedding-backend.js";
import type {
  EmbeddingTaskType,
  MultimodalEmbeddingInput,
} from "./embedding-types.js";
import { normalizeEmbeddingInput } from "./embedding-types.js";

interface GeminiEmbedResponse {
  embedding?: {
    values?: number[];
  };
}

export interface GeminiEmbeddingOptions {
  taskType?: EmbeddingTaskType;
  dimensions?: number;
  /** When set, routes requests through the managed proxy at this base URL. */
  managedBaseUrl?: string;
}

export class GeminiEmbeddingBackend implements EmbeddingBackend {
  readonly provider = "gemini" as const;
  readonly model: string;
  private readonly apiKey: string;
  private readonly taskType?: EmbeddingTaskType;
  private readonly dimensions?: number;
  private readonly managedBaseUrl?: string;

  constructor(apiKey: string, model: string, options?: GeminiEmbeddingOptions) {
    this.apiKey = apiKey;
    this.model = model;
    this.taskType = options?.taskType;
    this.dimensions = options?.dimensions;
    this.managedBaseUrl = options?.managedBaseUrl;
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
    const parts = this.buildParts(normalized);

    const body: Record<string, unknown> = {
      model: `models/${this.model}`,
      content: { parts },
    };
    if (this.taskType) body.taskType = this.taskType;
    if (this.dimensions) body.outputDimensionality = this.dimensions;

    const url = this.managedBaseUrl
      ? `${this.managedBaseUrl}/v1beta/models/${encodeURIComponent(this.model)}:embedContent`
      : `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:embedContent?key=${encodeURIComponent(this.apiKey)}`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.managedBaseUrl) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: options?.signal,
    });
    if (!response.ok) {
      const responseBody = await response.text();
      throw new Error(
        `Gemini embeddings request failed (${response.status}): ${responseBody}`,
      );
    }
    const payload = (await response.json()) as GeminiEmbedResponse;
    const values = payload.embedding?.values;
    if (!Array.isArray(values) || values.length === 0) {
      throw new Error("Gemini embeddings response missing vector values");
    }
    return values;
  }

  private buildParts(input: MultimodalEmbeddingInput): unknown[] {
    if (input.type === "text") {
      return [{ text: input.text }];
    }
    // Image, audio, video: use inline_data with base64
    return [
      {
        inline_data: {
          mime_type: input.mimeType,
          data: input.data.toString("base64"),
        },
      },
    ];
  }
}
