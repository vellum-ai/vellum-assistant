import { createHash } from "node:crypto";

import { getOllamaBaseUrlEnv } from "../config/env.js";
import type { AssistantConfig } from "../config/types.js";
import { getLogger } from "../util/logger.js";
import { GeminiEmbeddingBackend } from "./embedding-gemini.js";
import { OllamaEmbeddingBackend } from "./embedding-ollama.js";
import { OpenAIEmbeddingBackend } from "./embedding-openai.js";
import {
  type EmbeddingInput,
  embeddingInputContentHash,
  type MultimodalEmbeddingInput,
  normalizeEmbeddingInput,
  type TextEmbeddingInput,
} from "./embedding-types.js";

export type {
  EmbeddingInput,
  MultimodalEmbeddingInput,
  TextEmbeddingInput,
};
export { embeddingInputContentHash, normalizeEmbeddingInput };

const log = getLogger("memory-embeddings");

// Tracks whether the local embedding backend has permanently failed to load
// (e.g., onnxruntime-node missing in a compiled binary). Once set, `auto` mode
// skips `local` as primary, avoiding repeated fallback latency and cost.
let localBackendBroken = false;

/**
 * Lazy wrapper around LocalEmbeddingBackend that dynamically imports the
 * module on first use. This avoids eagerly loading @huggingface/transformers
 * (which statically imports onnxruntime-node) at module evaluation time.
 * In compiled binaries where onnxruntime-node isn't bundled, the static
 * import would crash the entire daemon at startup. By deferring the import,
 * the failure is contained and other embedding backends can be used instead.
 */

class LazyLocalEmbeddingBackend implements EmbeddingBackend {
  readonly provider = "local" as const;
  readonly model: string;
  private delegate: EmbeddingBackend | null = null;
  private initPromise: Promise<EmbeddingBackend> | null = null;

  constructor(model: string) {
    this.model = model;
  }

  async embed(
    inputs: EmbeddingInput[],
    options?: EmbeddingRequestOptions,
  ): Promise<number[][]> {
    const backend = await this.getDelegate();
    try {
      return await backend.embed(inputs, options);
    } catch (err) {
      // The onnxruntime-node failure surfaces here during the first embed() call
      // (via LocalEmbeddingBackend.initialize()). Mark broken so auto mode stops
      // selecting local on subsequent requests.
      if (!localBackendBroken && isInitializationError(err)) {
        localBackendBroken = true;
        log.warn(
          { err },
          "Local embedding backend permanently unavailable; auto mode will skip it",
        );
      }
      throw err;
    }
  }

  private async getDelegate(): Promise<EmbeddingBackend> {
    if (this.delegate) return this.delegate;
    if (!this.initPromise) {
      this.initPromise = (async () => {
        try {
          const { LocalEmbeddingBackend } =
            await import("./embedding-local.js");
          this.delegate = new LocalEmbeddingBackend(this.model);
          return this.delegate;
        } catch (err) {
          localBackendBroken = true;
          log.warn(
            { err },
            "Local embedding backend permanently unavailable; auto mode will skip it",
          );
          throw err;
        }
      })();
    }
    return this.initPromise;
  }
}

/** Detect errors thrown by LocalEmbeddingBackend.initialize() so we can
 *  distinguish permanent init failures from transient embed-time errors. */
function isInitializationError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.message.includes("Local embedding backend unavailable");
}

/** Global cache of embedding backend instances, keyed by "provider:model". */
const backendCache = new Map<string, EmbeddingBackend>();

// ── In-memory embedding vector cache ──────────────────────────────
// LRU cache keyed by sha256(provider + model + text) → embedding vector.
// Avoids redundant API calls / local compute for identical content.
// Eviction is based on estimated byte size (32 MB cap) rather than entry count,
// since vector dimensions vary across providers/models.
const VECTOR_CACHE_MAX_BYTES = 33_554_432; // 32 MB
const vectorCache = new Map<string, number[]>();
let vectorCacheBytes = 0;

/** Estimate in-memory byte cost of a single cache entry. */
function estimateEntryBytes(key: string, vector: number[]): number {
  // key: UTF-16 chars (2 bytes each) + vector: 8 bytes per float64
  return key.length * 2 + vector.length * 8;
}

function vectorCacheKey(provider: string, model: string, input: EmbeddingInput): string {
  const contentHash = embeddingInputContentHash(input);
  return createHash("sha256")
    .update(`${provider}\0${model}\0${contentHash}`)
    .digest("hex");
}

function getFromVectorCache(
  provider: string,
  model: string,
  input: EmbeddingInput,
): number[] | undefined {
  const key = vectorCacheKey(provider, model, input);
  const v = vectorCache.get(key);
  if (v !== undefined) {
    // LRU refresh: move to end of insertion order
    vectorCache.delete(key);
    vectorCache.set(key, v);
  }
  return v;
}

function putInVectorCache(
  provider: string,
  model: string,
  input: EmbeddingInput,
  vector: number[],
): void {
  const key = vectorCacheKey(provider, model, input);
  // If replacing an existing entry, subtract its old cost first
  const existing = vectorCache.get(key);
  if (existing !== undefined) {
    vectorCacheBytes -= estimateEntryBytes(key, existing);
    vectorCache.delete(key);
  }
  const entryBytes = estimateEntryBytes(key, vector);
  // Evict oldest entries until we have room
  while (
    vectorCacheBytes + entryBytes > VECTOR_CACHE_MAX_BYTES &&
    vectorCache.size > 0
  ) {
    const oldest = vectorCache.keys().next().value;
    if (oldest === undefined) break;
    const oldVec = vectorCache.get(oldest)!;
    vectorCacheBytes -= estimateEntryBytes(oldest, oldVec);
    vectorCache.delete(oldest);
  }
  vectorCache.set(key, vector);
  vectorCacheBytes += entryBytes;
}

/** Clear cached embedding backends and the in-memory vector cache. */
export function clearEmbeddingBackendCache(): void {
  backendCache.clear();
  vectorCache.clear();
  vectorCacheBytes = 0;
  localBackendBroken = false;
}

function cacheKey(provider: string, model: string, extras?: string[]): string {
  if (extras && extras.length > 0) {
    return `${provider}:${model}:${extras.join(":")}`;
  }
  return `${provider}:${model}`;
}

function getCachedOrCreate<T extends EmbeddingBackend>(
  provider: string,
  model: string,
  create: () => T,
  extras?: string[],
): T {
  const key = cacheKey(provider, model, extras);
  const existing = backendCache.get(key);
  if (existing) return existing as T;
  const instance = create();
  backendCache.set(key, instance);
  return instance;
}

function geminiCacheExtras(config: AssistantConfig): string[] {
  const extras: string[] = [];
  if (config.memory.embeddings.geminiTaskType) {
    extras.push(`task=${config.memory.embeddings.geminiTaskType}`);
  }
  if (config.memory.embeddings.geminiDimensions != null) {
    extras.push(`dim=${config.memory.embeddings.geminiDimensions}`);
  }
  return extras;
}

export type EmbeddingProviderName = "local" | "openai" | "gemini" | "ollama";

export interface EmbeddingRequestOptions {
  signal?: AbortSignal;
}

export interface EmbeddingBackend {
  readonly provider: EmbeddingProviderName;
  readonly model: string;
  embed(
    inputs: EmbeddingInput[],
    options?: EmbeddingRequestOptions,
  ): Promise<number[][]>;
}

export interface EmbeddingBackendSelection {
  backend: EmbeddingBackend | null;
  reason: string | null;
}

export function selectEmbeddingBackend(
  config: AssistantConfig,
): EmbeddingBackendSelection {
  const requested = config.memory.embeddings.provider;
  if (requested === "local") {
    return {
      backend: getCachedOrCreate(
        "local",
        config.memory.embeddings.localModel,
        () =>
          new LazyLocalEmbeddingBackend(config.memory.embeddings.localModel),
      ),
      reason: null,
    };
  }
  if (requested === "ollama") {
    return {
      backend: getCachedOrCreate(
        "ollama",
        config.memory.embeddings.ollamaModel,
        () =>
          new OllamaEmbeddingBackend(config.memory.embeddings.ollamaModel, {
            apiKey: config.apiKeys.ollama,
          }),
      ),
      reason: null,
    };
  }

  // Auto order: local → openai → gemini → ollama
  const order: EmbeddingProviderName[] =
    requested === "auto"
      ? ["local", "openai", "gemini", "ollama"]
      : [requested];

  for (const provider of order) {
    switch (provider) {
      case "local":
        if (localBackendBroken) continue;
        return {
          backend: getCachedOrCreate(
            "local",
            config.memory.embeddings.localModel,
            () =>
              new LazyLocalEmbeddingBackend(
                config.memory.embeddings.localModel,
              ),
          ),
          reason: null,
        };
      case "openai":
        if (!config.apiKeys.openai) continue;
        return {
          backend: getCachedOrCreate(
            "openai",
            config.memory.embeddings.openaiModel,
            () =>
              new OpenAIEmbeddingBackend(
                config.apiKeys.openai,
                config.memory.embeddings.openaiModel,
              ),
          ),
          reason: null,
        };
      case "gemini":
        if (!config.apiKeys.gemini) continue;
        return {
          backend: getCachedOrCreate(
            "gemini",
            config.memory.embeddings.geminiModel,
            () =>
              new GeminiEmbeddingBackend(
                config.apiKeys.gemini,
                config.memory.embeddings.geminiModel,
                {
                  taskType: config.memory.embeddings.geminiTaskType,
                  dimensions: config.memory.embeddings.geminiDimensions,
                },
              ),
            geminiCacheExtras(config),
          ),
          reason: null,
        };
      case "ollama":
        if (!isOllamaConfigured(config)) continue;
        return {
          backend: getCachedOrCreate(
            "ollama",
            config.memory.embeddings.ollamaModel,
            () =>
              new OllamaEmbeddingBackend(config.memory.embeddings.ollamaModel, {
                apiKey: config.apiKeys.ollama,
              }),
          ),
          reason: null,
        };
    }
  }

  const reason =
    requested === "auto"
      ? "No embedding backend configured"
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
    return {
      enabled: false,
      degraded: false,
      provider: null,
      model: null,
      reason: "memory.disabled",
    };
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
  inputs: EmbeddingInput[],
  options?: EmbeddingRequestOptions,
): Promise<{
  provider: EmbeddingProviderName;
  model: string;
  vectors: number[][];
}> {
  const selection = selectEmbeddingBackend(config);
  if (!selection.backend) {
    throw new Error(
      selection.reason ?? "No memory embedding backend configured",
    );
  }

  const expectedDim = config.memory.qdrant.vectorSize;
  const { provider: primaryProvider, model: primaryModel } = selection.backend;

  // ── Build fallback backends list (needed for embed fallback) ──
  const fallbacks: EmbeddingBackend[] =
    config.memory.embeddings.provider === "auto" &&
    selection.backend.provider === "local"
      ? selectFallbackBackends(config, "local")
      : [];

  // ── In-memory cache check (primary provider only) ──────────────
  const cached: (number[] | null)[] = inputs.map((input) => {
    const v = getFromVectorCache(primaryProvider, primaryModel, input);
    if (v && v.length === expectedDim) return v;
    return null;
  });
  const uncachedIndices: number[] = [];
  for (let i = 0; i < cached.length; i++) {
    if (!cached[i]) uncachedIndices.push(i);
  }
  if (uncachedIndices.length === 0) {
    return {
      provider: primaryProvider,
      model: primaryModel,
      vectors: cached as number[][],
    };
  }

  // ── Embed uncached inputs ───────────────────────────────────────
  const backends: EmbeddingBackend[] = [selection.backend, ...fallbacks];

  let lastErr: unknown;
  let anyBackendAttempted = false;
  for (const backend of backends) {
    const isPrimary = backend === selection.backend;
    // For the primary backend, only embed uncached inputs and merge with cached.
    // For fallback backends, embed ALL inputs since the cache was keyed to the primary.
    const inputsToEmbed = isPrimary
      ? uncachedIndices.map((i) => inputs[i])
      : inputs;

    // Skip text-only backends for multimodal inputs
    const hasNonText = inputsToEmbed.some(
      (i) => typeof i !== "string" && normalizeEmbeddingInput(i).type !== "text",
    );
    if (backend.provider !== "gemini" && hasNonText) {
      continue;
    }

    try {
      anyBackendAttempted = true;
      const vectors = await backend.embed(inputsToEmbed, options);
      if (vectors.length !== inputsToEmbed.length) {
        throw new Error(
          `Embedding backend returned ${vectors.length} vectors for ${inputsToEmbed.length} inputs`,
        );
      }
      for (const vec of vectors) {
        if (vec.length !== expectedDim) {
          throw new Error(
            `Embedding backend "${backend.provider}" (model ${backend.model}) returned vectors of dimension ${vec.length}, but Qdrant collection expects ${expectedDim}`,
          );
        }
      }

      // Populate cache with freshly embedded vectors
      for (let i = 0; i < inputsToEmbed.length; i++) {
        putInVectorCache(
          backend.provider,
          backend.model,
          inputsToEmbed[i],
          vectors[i],
        );
      }

      if (isPrimary) {
        const merged = [...cached] as number[][];
        for (let i = 0; i < uncachedIndices.length; i++) {
          merged[uncachedIndices[i]] = vectors[i];
        }
        return {
          provider: backend.provider,
          model: backend.model,
          vectors: merged,
        };
      }
      return { provider: backend.provider, model: backend.model, vectors };
    } catch (err) {
      lastErr = err;
      if (backends.length > 1) {
        log.warn(
          { err, provider: backend.provider },
          "Embedding backend failed, trying next",
        );
      }
    }
  }
  if (!anyBackendAttempted) {
    const hasMultimodal = inputs.some(
      (i) => typeof i !== "string" && normalizeEmbeddingInput(i).type !== "text",
    );
    if (hasMultimodal) {
      throw new Error(
        "No available embedding backend supports multimodal inputs. Gemini API key is required for image/audio/video embeddings.",
      );
    }
  }
  throw lastErr;
}

export function logMemoryEmbeddingWarning(err: unknown, context: string): void {
  log.warn({ err }, `Memory embeddings failed (${context})`);
}

function selectFallbackBackends(
  config: AssistantConfig,
  exclude: EmbeddingProviderName,
): EmbeddingBackend[] {
  const backends: EmbeddingBackend[] = [];
  const order: EmbeddingProviderName[] = ["openai", "gemini", "ollama"];
  for (const provider of order) {
    if (provider === exclude) continue;
    switch (provider) {
      case "openai":
        if (config.apiKeys.openai) {
          backends.push(
            getCachedOrCreate(
              "openai",
              config.memory.embeddings.openaiModel,
              () =>
                new OpenAIEmbeddingBackend(
                  config.apiKeys.openai,
                  config.memory.embeddings.openaiModel,
                ),
            ),
          );
        }
        break;
      case "gemini":
        if (config.apiKeys.gemini) {
          backends.push(
            getCachedOrCreate(
              "gemini",
              config.memory.embeddings.geminiModel,
              () =>
                new GeminiEmbeddingBackend(
                  config.apiKeys.gemini,
                  config.memory.embeddings.geminiModel,
                  {
                    taskType: config.memory.embeddings.geminiTaskType,
                    dimensions: config.memory.embeddings.geminiDimensions,
                  },
                ),
              geminiCacheExtras(config),
            ),
          );
        }
        break;
      case "ollama":
        if (isOllamaConfigured(config)) {
          backends.push(
            getCachedOrCreate(
              "ollama",
              config.memory.embeddings.ollamaModel,
              () =>
                new OllamaEmbeddingBackend(
                  config.memory.embeddings.ollamaModel,
                  {
                    apiKey: config.apiKeys.ollama,
                  },
                ),
            ),
          );
        }
        break;
    }
  }
  return backends;
}

function isOllamaConfigured(config: AssistantConfig): boolean {
  return (
    config.provider === "ollama" ||
    Boolean(config.apiKeys.ollama) ||
    Boolean(getOllamaBaseUrlEnv())
  );
}
