import OpenAI from "openai";

import type {
  EmbeddingBackend,
  EmbeddingInput,
  EmbeddingRequestOptions,
} from "./embedding-backend.js";
import { normalizeEmbeddingInput } from "./embedding-types.js";

export class OpenAIEmbeddingBackend implements EmbeddingBackend {
  readonly provider = "openai" as const;
  readonly model: string;
  private readonly client: OpenAI;

  constructor(apiKey: string, model: string) {
    this.model = model;
    this.client = new OpenAI({ apiKey });
  }

  async embed(
    inputs: EmbeddingInput[],
    options?: EmbeddingRequestOptions,
  ): Promise<number[][]> {
    if (inputs.length === 0) return [];

    const texts = inputs.map((i) => {
      const n = normalizeEmbeddingInput(i);
      if (n.type !== "text") {
        throw new Error(
          "OpenAI embedding backend only supports text inputs",
        );
      }
      return n.text;
    });

    const response = await this.client.embeddings.create(
      {
        model: this.model,
        input: texts,
        encoding_format: "float",
      },
      {
        signal: options?.signal,
      },
    );
    return response.data.map((item) => item.embedding);
  }
}
