import { getLogger } from "../../util/logger.js";
import type {
  EmbeddingBackend,
  EmbeddingInput,
  EmbeddingRequestOptions,
  EmbeddingTaskType,
  MultimodalEmbeddingInput,
} from "./embedding-types.js";
import { normalizeEmbeddingInput } from "./embedding-types.js";

const log = getLogger("memory-embeddings");

interface GeminiEmbedResponse {
  embedding?: {
    values?: number[];
  };
}

interface GeminiBatchEmbedResponse {
  embeddings?: Array<{ values?: number[] }>;
}

/** Texts per `batchEmbedContents` call, the API's documented maximum. */
export const GEMINI_EMBED_BATCH_SIZE = 100;

/**
 * Response statuses that say the batch route itself is unavailable (a proxy
 * that forwards only `embedContent`), as opposed to a bad request or a
 * transient failure. The backend then stays on the single route.
 */
const BATCH_ROUTE_UNAVAILABLE_STATUSES = new Set([404, 405, 501]);

export interface GeminiEmbeddingOptions {
  taskType?: EmbeddingTaskType;
  dimensions?: number;
  /** When set, routes requests through the managed proxy at this base URL. */
  managedBaseUrl?: string;
  /**
   * Milliseconds to sleep between sequential embed calls to yield to the
   * event loop. Defaults to 5000 in production; set to 0 in tests.
   */
  interCallDelayMs?: number;
}

export class GeminiEmbeddingBackend implements EmbeddingBackend {
  readonly provider = "gemini" as const;
  readonly model: string;
  private readonly apiKey: string;
  private readonly taskType?: EmbeddingTaskType;
  private readonly dimensions?: number;
  private readonly managedBaseUrl?: string;
  private readonly interCallDelayMs: number;
  /**
   * Set once the batch route has answered that it does not exist, so later
   * calls take the single route without a wasted round trip per batch.
   */
  private batchRouteUnavailable = false;

  constructor(apiKey: string, model: string, options?: GeminiEmbeddingOptions) {
    this.apiKey = apiKey;
    this.model = model;
    this.taskType = options?.taskType;
    this.dimensions = options?.dimensions;
    this.managedBaseUrl = options?.managedBaseUrl;
    this.interCallDelayMs = options?.interCallDelayMs ?? 100;
  }

  /** True when requests route through the managed platform proxy. */
  get managed(): boolean {
    return Boolean(this.managedBaseUrl);
  }

  /**
   * Embed `inputs` in order. Runs of text inputs go through
   * `batchEmbedContents`, {@link GEMINI_EMBED_BATCH_SIZE} texts per round
   * trip, so a corpus re-embed costs one request per hundred sections rather
   * than one per section; a lone text and every multimodal input take the
   * single `embedContent` route. A batch the API rejects as a bad request, or
   * answers with a malformed body, is re-sent as single calls, so each of its
   * inputs succeeds or fails independently; a batch route that does not exist
   * is remembered and skipped for the rest of the backend's life. Transient
   * failures (rate limits, server errors, network) throw, so they reach the
   * caller's retry policy.
   */
  async embed(
    inputs: EmbeddingInput[],
    options?: EmbeddingRequestOptions,
  ): Promise<number[][]> {
    const normalized = inputs.map(normalizeEmbeddingInput);
    const vectors: number[][] = new Array(normalized.length);
    let i = 0;
    while (i < normalized.length) {
      if (i > 0) {
        await this.yieldBetweenCalls();
      }
      const input = normalized[i]!;
      // Gather the run of text inputs starting here, up to one batch.
      let end = i;
      while (
        !this.batchRouteUnavailable &&
        end < normalized.length &&
        end - i < GEMINI_EMBED_BATCH_SIZE &&
        normalized[end]!.type === "text"
      ) {
        end += 1;
      }
      if (end - i < 2) {
        vectors[i] = await this.embedSingle(input, options);
        i += 1;
        continue;
      }
      const run = normalized.slice(i, end);
      const batch = await this.embedBatch(run, options);
      if (batch) {
        for (let j = 0; j < run.length; j++) {
          vectors[i + j] = batch[j]!;
        }
      } else {
        for (let j = 0; j < run.length; j++) {
          if (j > 0) {
            await this.yieldBetweenCalls();
          }
          vectors[i + j] = await this.embedSingle(run[j]!, options);
        }
      }
      i = end;
    }
    return vectors;
  }

  /**
   * Yield to the event loop between sequential calls so the daemon can serve
   * HTTP requests, health checks, and cron ticks while a large embed (a
   * startup skill reseed, a concept-page re-embed) is in flight.
   */
  private async yieldBetweenCalls(): Promise<void> {
    if (this.interCallDelayMs > 0) {
      await Bun.sleep(this.interCallDelayMs);
    }
  }

  /**
   * One `batchEmbedContents` round trip for a run of text inputs. Resolves to
   * the vectors in input order, or to `null` when the run should be re-sent
   * as single calls: the route is unavailable (remembered), the request was
   * rejected as bad, or the body did not carry one vector per input.
   */
  private async embedBatch(
    run: MultimodalEmbeddingInput[],
    options?: EmbeddingRequestOptions,
  ): Promise<number[][] | null> {
    // Unlike `embedContent`, each batched request names its model, and the
    // API wants the `models/` resource prefix there.
    const requests = run.map((input) => {
      const request: Record<string, unknown> = {
        model: `models/${this.model}`,
        content: { parts: this.buildParts(input) },
      };
      if (this.taskType) {
        request.taskType = this.taskType;
      }
      if (this.dimensions) {
        request.outputDimensionality = this.dimensions;
      }
      return request;
    });
    const response = await fetch(this.endpointUrl("batchEmbedContents"), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ requests }),
      signal: options?.signal,
    });
    if (!response.ok) {
      const responseBody = await response.text();
      if (BATCH_ROUTE_UNAVAILABLE_STATUSES.has(response.status)) {
        this.batchRouteUnavailable = true;
        log.warn(
          { status: response.status, managed: this.managed },
          "Gemini batch embeddings route unavailable; embedding one text per call from here on",
        );
        return null;
      }
      if (response.status === 400) {
        log.warn(
          { status: response.status, inputs: run.length, responseBody },
          "Gemini batch embeddings request rejected; re-sending this batch one text per call",
        );
        return null;
      }
      throw new Error(
        `Gemini batch embeddings request failed (${response.status}): ${responseBody}`,
      );
    }
    const payload = (await response.json()) as GeminiBatchEmbedResponse;
    const embeddings = payload.embeddings;
    const vectors: number[][] = [];
    if (Array.isArray(embeddings) && embeddings.length === run.length) {
      for (const embedding of embeddings) {
        const values = embedding?.values;
        if (!Array.isArray(values) || values.length === 0) {
          break;
        }
        vectors.push(values);
      }
    }
    if (vectors.length !== run.length) {
      log.warn(
        { inputs: run.length, vectors: vectors.length },
        "Gemini batch embeddings response did not carry one vector per input; re-sending this batch one text per call",
      );
      return null;
    }
    return vectors;
  }

  private async embedSingle(
    input: MultimodalEmbeddingInput,
    options?: EmbeddingRequestOptions,
  ): Promise<number[]> {
    const parts = this.buildParts(input);
    const body: Record<string, unknown> = {
      content: { parts },
    };
    // Do NOT set `model` in the body. Gemini's embedContent API models `model`
    // as a protobuf oneof populated from the URL path (internally `_model`),
    // so adding it to the body triggers a 400: "oneof field '_model' is
    // already set. Cannot set 'model'". This holds for both the direct API
    // and the managed proxy, which forwards the body unchanged; the platform
    // billing layer parses the model from the URL path instead.
    if (this.taskType) {
      body.taskType = this.taskType;
    }
    if (this.dimensions) {
      body.outputDimensionality = this.dimensions;
    }
    const response = await fetch(this.endpointUrl("embedContent"), {
      method: "POST",
      headers: this.headers(),
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

  /** The model's `:embedContent` or `:batchEmbedContents` URL, direct or via the managed proxy. */
  private endpointUrl(method: "embedContent" | "batchEmbedContents"): string {
    const model = encodeURIComponent(this.model);
    return this.managedBaseUrl
      ? `${this.managedBaseUrl}/v1beta/models/${model}:${method}`
      : `https://generativelanguage.googleapis.com/v1beta/models/${model}:${method}?key=${encodeURIComponent(this.apiKey)}`;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.managedBaseUrl) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }
    return headers;
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
