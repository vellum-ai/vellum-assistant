import OpenAI from "openai";

import {
  type EmbeddingBackend,
  type EmbeddingInput,
  type EmbeddingProviderName,
  type EmbeddingRequestOptions,
  normalizeEmbeddingInput,
} from "./embedding-types.js";

export type OpenAICompatibleEmbeddingProvider = Extract<
  EmbeddingProviderName,
  "openai" | "custom"
>;

export interface OpenAIEmbeddingOptions {
  baseURL?: string;
  dimensions?: number;
  provider?: OpenAICompatibleEmbeddingProvider;
}

const PLACEHOLDER_API_KEY = "not-needed";

export class OpenAIEmbeddingBackend implements EmbeddingBackend {
  readonly provider: OpenAICompatibleEmbeddingProvider;
  readonly model: string;
  readonly baseURL?: string;
  readonly dimensions?: number;
  private readonly client: OpenAI;

  constructor(apiKey: string, model: string, options?: OpenAIEmbeddingOptions) {
    this.model = model;
    this.provider = options?.provider ?? "openai";
    this.baseURL = options?.baseURL;
    this.dimensions = options?.dimensions;
    this.client = new OpenAI({
      apiKey: apiKey || PLACEHOLDER_API_KEY,
      ...(options?.baseURL ? { baseURL: options.baseURL } : {}),
    });
  }

  async embed(
    inputs: EmbeddingInput[],
    options?: EmbeddingRequestOptions,
  ): Promise<number[][]> {
    if (inputs.length === 0) {
      return [];
    }

    const texts = inputs.map((i) => {
      const n = normalizeEmbeddingInput(i);
      if (n.type !== "text") {
        throw new Error(
          `${this.provider === "custom" ? "Custom" : "OpenAI"} embedding backend only supports text inputs`,
        );
      }
      return n.text;
    });

    const response = await this.client.embeddings.create(
      {
        model: this.model,
        input: texts,
        encoding_format: "float",
        ...(this.dimensions != null ? { dimensions: this.dimensions } : {}),
      },
      {
        signal: options?.signal,
      },
    );
    return response.data.map((item) => item.embedding);
  }
}

/**
 * Trim and strip a trailing slash from a user-supplied OpenAI-compatible
 * embeddings base URL. Returns null when the value is empty, not http(s),
 * or not a valid absolute URL.
 */
export function resolveOpenAICompatibleBaseUrl(
  value: string | undefined,
): string | null {
  if (value == null) {
    return null;
  }
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
  } catch {
    return null;
  }
  return trimmed;
}
