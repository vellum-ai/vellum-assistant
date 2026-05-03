import { createHash } from "node:crypto";

import { isAssistantFeatureFlagEnabled } from "../config/assistant-feature-flags.js";
import { getOllamaBaseUrlEnv } from "../config/env.js";
import type { AssistantConfig } from "../config/types.js";
import { MANAGED_PROVIDER_META } from "../providers/managed-proxy/constants.js";
import { resolveManagedProxyContext } from "../providers/managed-proxy/context.js";
import { getProviderKeyAsync } from "../security/secure-keys.js";
import { getLogger } from "../util/logger.js";
import { GeminiEmbeddingBackend } from "./embedding-gemini.js";
import { OllamaEmbeddingBackend } from "./embedding-ollama.js";
import { OpenAIEmbeddingBackend } from "./embedding-openai.js";
import {
  type EmbeddingBackend,
  type EmbeddingInput,
  embeddingInputContentHash,
  type EmbeddingProviderName,
  type EmbeddingRequestOptions,
  type MultimodalEmbeddingInput,
  normalizeEmbeddingInput,
  type SparseEmbedding,
  type TextEmbeddingInput,
} from "./embedding-types.js";

export type { EmbeddingInput, MultimodalEmbeddingInput, TextEmbeddingInput };

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

  dispose(): void {
    this.delegate?.dispose?.();
  }

  resetForRetry(): void {
    if (!this.delegate) {
      this.initPromise = null;
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

function vectorCacheKey(
  provider: string,
  model: string,
  input: EmbeddingInput,
  extras?: string[],
): string {
  const contentHash = embeddingInputContentHash(input);
  const suffix = extras && extras.length > 0 ? `\0${extras.join("\0")}` : "";
  return createHash("sha256")
    .update(`${provider}\0${model}\0${contentHash}${suffix}`)
    .digest("hex");
}

function getFromVectorCache(
  provider: string,
  model: string,
  input: EmbeddingInput,
  extras?: string[],
): number[] | undefined {
  const key = vectorCacheKey(provider, model, input, extras);
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
  extras?: string[],
): void {
  const key = vectorCacheKey(provider, model, input, extras);
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
  for (const backend of new Set(backendCache.values())) {
    try {
      backend.dispose?.();
    } catch (err) {
      log.warn(
        { err, provider: backend.provider, model: backend.model },
        "Failed to dispose embedding backend during cache clear",
      );
    }
  }
  backendCache.clear();
  vectorCache.clear();
  vectorCacheBytes = 0;
  localBackendBroken = false;
}

/** Reset the sticky local-backend failure flag without evicting live backends. */
export function resetLocalEmbeddingFailureState(): void {
  localBackendBroken = false;
  for (const backend of new Set(backendCache.values())) {
    if (backend instanceof LazyLocalEmbeddingBackend) {
      backend.resetForRetry();
    }
  }
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

/**
 * Look up a previously cached backend instance. Returns undefined when no
 * cached entry exists. Used as a fallback when a provider key lookup
 * returns undefined — a transient credential-store outage should not
 * disable a provider whose backend is already warmed in memory. Explicit
 * key deletion triggers `clearEmbeddingBackendCache()` which empties the
 * cache, so a stale backend is never returned after intentional removal.
 */
function getCached(
  provider: string,
  model: string,
  extras?: string[],
): EmbeddingBackend | undefined {
  return backendCache.get(cacheKey(provider, model, extras));
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

export interface EmbeddingBackendSelection {
  backend: EmbeddingBackend | null;
  reason: string | null;
}

export async function selectEmbeddingBackend(
  config: AssistantConfig,
): Promise<EmbeddingBackendSelection> {
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
    const ollamaKey = (await getProviderKeyAsync("ollama")) ?? undefined;
    return {
      backend: getCachedOrCreate(
        "ollama",
        config.memory.embeddings.ollamaModel,
        () =>
          new OllamaEmbeddingBackend(config.memory.embeddings.ollamaModel, {
            apiKey: ollamaKey,
          }),
      ),
      reason: null,
    };
  }

  // When the managed-gemini-embeddings-enabled flag is on AND managed proxy
  // prerequisites are satisfied, insert managed-proxy Gemini at the front of
  // the auto chain so platform assistants use Vellum-managed Gemini embeddings.
  if (
    (requested === "auto" || requested === "gemini") &&
    isAssistantFeatureFlagEnabled("managed-gemini-embeddings-enabled", config)
  ) {
    const proxyCtx = await resolveManagedProxyContext();
    if (proxyCtx.enabled) {
      const meta = MANAGED_PROVIDER_META["gemini"];
      if (meta?.managed && meta.proxyPath) {
        const managedBaseUrl = `${proxyCtx.platformBaseUrl}${meta.proxyPath}`;
        const managedModel = config.memory.embeddings.geminiModel;
        const managedDimensions =
          config.memory.embeddings.geminiDimensions ?? 3072;
        const extras = geminiCacheExtras(config);
        return {
          backend: getCachedOrCreate(
            "gemini",
            managedModel,
            () =>
              new GeminiEmbeddingBackend(
                proxyCtx.assistantApiKey,
                managedModel,
                {
                  taskType: config.memory.embeddings.geminiTaskType,
                  dimensions: managedDimensions,
                  managedBaseUrl,
                },
              ),
            [...extras, "managed"],
          ),
          reason: null,
        };
      }
    }
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
      case "openai": {
        const openaiKey = await getProviderKeyAsync("openai");
        if (!openaiKey) {
          // Preserve cached backend on transient credential-store failures.
          // Explicit key deletion clears the cache via clearEmbeddingBackendCache().
          const cached = getCached(
            "openai",
            config.memory.embeddings.openaiModel,
          );
          if (cached) return { backend: cached, reason: null };
          continue;
        }
        return {
          backend: getCachedOrCreate(
            "openai",
            config.memory.embeddings.openaiModel,
            () =>
              new OpenAIEmbeddingBackend(
                openaiKey,
                config.memory.embeddings.openaiModel,
              ),
          ),
          reason: null,
        };
      }
      case "gemini": {
        const geminiKey = await getProviderKeyAsync("gemini");
        if (!geminiKey) {
          // Check managed cache variant first so a warm managed backend
          // survives transient proxy-context blips, then non-managed.
          const cached =
            getCached("gemini", config.memory.embeddings.geminiModel, [
              ...geminiCacheExtras(config),
              "managed",
            ]) ??
            getCached(
              "gemini",
              config.memory.embeddings.geminiModel,
              geminiCacheExtras(config),
            );
          if (cached) return { backend: cached, reason: null };
          continue;
        }
        return {
          backend: getCachedOrCreate(
            "gemini",
            config.memory.embeddings.geminiModel,
            () =>
              new GeminiEmbeddingBackend(
                geminiKey,
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
      }
      case "ollama": {
        if (!(await isOllamaConfigured(config))) continue;
        const ollamaKey = (await getProviderKeyAsync("ollama")) ?? undefined;
        return {
          backend: getCachedOrCreate(
            "ollama",
            config.memory.embeddings.ollamaModel,
            () =>
              new OllamaEmbeddingBackend(config.memory.embeddings.ollamaModel, {
                apiKey: ollamaKey,
              }),
          ),
          reason: null,
        };
      }
    }
  }

  const reason =
    requested === "auto"
      ? "No embedding backend configured"
      : `Embedding backend "${requested}" is not configured`;
  return { backend: null, reason };
}

export async function getMemoryBackendStatus(config: AssistantConfig): Promise<{
  enabled: boolean;
  degraded: boolean;
  provider: EmbeddingProviderName | null;
  model: string | null;
  reason: string | null;
}> {
  if (!config.memory.enabled) {
    return {
      enabled: false,
      degraded: false,
      provider: null,
      model: null,
      reason: "memory.disabled",
    };
  }
  const selection = await selectEmbeddingBackend(config);
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
  const selection = await selectEmbeddingBackend(config);
  if (!selection.backend) {
    throw new Error(
      selection.reason ?? "No memory embedding backend configured",
    );
  }

  const expectedDim = config.memory.qdrant.vectorSize;
  const { provider: primaryProvider, model: primaryModel } = selection.backend;

  // ── Build fallback backends list (needed for embed fallback) ──
  // In auto mode, build a fallback chain from all configured backends
  // (excluding the primary). This lets multimodal inputs fall through
  // to Gemini even when the primary is local or openai.
  const fallbacks: EmbeddingBackend[] =
    config.memory.embeddings.provider === "auto" &&
    selection.backend.provider !== "gemini"
      ? await selectFallbackBackends(config, selection.backend.provider)
      : [];

  // ── Compute provider-specific vector cache extras ───────────────
  const vectorExtras =
    primaryProvider === "gemini" ? geminiCacheExtras(config) : undefined;

  // ── In-memory cache check (primary provider only) ──────────────
  const cached: (number[] | null)[] = inputs.map((input) => {
    const v = getFromVectorCache(
      primaryProvider,
      primaryModel,
      input,
      vectorExtras,
    );
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
      (i) =>
        typeof i !== "string" && normalizeEmbeddingInput(i).type !== "text",
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
      const backendExtras =
        backend.provider === "gemini" ? geminiCacheExtras(config) : undefined;
      for (let i = 0; i < inputsToEmbed.length; i++) {
        putInVectorCache(
          backend.provider,
          backend.model,
          inputsToEmbed[i],
          vectors[i],
          backendExtras,
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
      (i) =>
        typeof i !== "string" && normalizeEmbeddingInput(i).type !== "text",
    );
    if (hasMultimodal) {
      throw new Error(
        "No available embedding backend supports multimodal inputs. Gemini API key is required for image/audio/video embeddings.",
      );
    }
  }
  throw lastErr;
}

async function selectFallbackBackends(
  config: AssistantConfig,
  exclude: EmbeddingProviderName,
): Promise<EmbeddingBackend[]> {
  const backends: EmbeddingBackend[] = [];
  const order: EmbeddingProviderName[] = ["openai", "gemini", "ollama"];
  for (const provider of order) {
    if (provider === exclude) continue;
    switch (provider) {
      case "openai": {
        const openaiKey = await getProviderKeyAsync("openai");
        if (openaiKey) {
          backends.push(
            getCachedOrCreate(
              "openai",
              config.memory.embeddings.openaiModel,
              () =>
                new OpenAIEmbeddingBackend(
                  openaiKey,
                  config.memory.embeddings.openaiModel,
                ),
            ),
          );
        } else {
          // Preserve cached backend on transient credential-store failures.
          const cached = getCached(
            "openai",
            config.memory.embeddings.openaiModel,
          );
          if (cached) backends.push(cached);
        }
        break;
      }
      case "gemini": {
        const geminiKey = await getProviderKeyAsync("gemini");
        if (geminiKey) {
          backends.push(
            getCachedOrCreate(
              "gemini",
              config.memory.embeddings.geminiModel,
              () =>
                new GeminiEmbeddingBackend(
                  geminiKey,
                  config.memory.embeddings.geminiModel,
                  {
                    taskType: config.memory.embeddings.geminiTaskType,
                    dimensions: config.memory.embeddings.geminiDimensions,
                  },
                ),
              geminiCacheExtras(config),
            ),
          );
        } else if (
          isAssistantFeatureFlagEnabled(
            "managed-gemini-embeddings-enabled",
            config,
          )
        ) {
          // Try managed proxy Gemini as fallback when no direct key exists.
          const proxyCtx = await resolveManagedProxyContext();
          const meta = MANAGED_PROVIDER_META["gemini"];
          if (proxyCtx.enabled && meta?.managed && meta.proxyPath) {
            const managedBaseUrl = `${proxyCtx.platformBaseUrl}${meta.proxyPath}`;
            const managedModel = config.memory.embeddings.geminiModel;
            const managedDimensions =
              config.memory.embeddings.geminiDimensions ?? 3072;
            const extras = geminiCacheExtras(config);
            backends.push(
              getCachedOrCreate(
                "gemini",
                managedModel,
                () =>
                  new GeminiEmbeddingBackend(
                    proxyCtx.assistantApiKey,
                    managedModel,
                    {
                      taskType: config.memory.embeddings.geminiTaskType,
                      dimensions: managedDimensions,
                      managedBaseUrl,
                    },
                  ),
                [...extras, "managed"],
              ),
            );
          } else {
            // Check managed cache variant first, then non-managed, so a warm
            // managed backend survives transient proxy-context blips.
            const cached =
              getCached("gemini", config.memory.embeddings.geminiModel, [
                ...geminiCacheExtras(config),
                "managed",
              ]) ??
              getCached(
                "gemini",
                config.memory.embeddings.geminiModel,
                geminiCacheExtras(config),
              );
            if (cached) backends.push(cached);
          }
        } else {
          // Preserve cached backend on transient credential-store failures.
          const cached = getCached(
            "gemini",
            config.memory.embeddings.geminiModel,
            geminiCacheExtras(config),
          );
          if (cached) backends.push(cached);
        }
        break;
      }
      case "ollama": {
        if (await isOllamaConfigured(config)) {
          const ollamaKey = (await getProviderKeyAsync("ollama")) ?? undefined;
          backends.push(
            getCachedOrCreate(
              "ollama",
              config.memory.embeddings.ollamaModel,
              () =>
                new OllamaEmbeddingBackend(
                  config.memory.embeddings.ollamaModel,
                  {
                    apiKey: ollamaKey,
                  },
                ),
            ),
          );
        }
        break;
      }
    }
  }
  return backends;
}

/**
 * Returns true when the active (primary) embedding backend can handle
 * multimodal inputs (images, audio, video). Today only Gemini supports
 * multimodal.
 *
 * Only returns true when Gemini is the primary selected backend — not when
 * it's merely available as a fallback. Writing multimodal embeddings via a
 * fallback provider while queries go through the primary text backend would
 * mix incompatible vector spaces, making retrieval unreliable.
 */
export async function selectedBackendSupportsMultimodal(
  config: AssistantConfig,
): Promise<boolean> {
  const { backend } = await selectEmbeddingBackend(config);
  if (!backend) return false;
  return backend.provider === "gemini";
}

async function isOllamaConfigured(config: AssistantConfig): Promise<boolean> {
  return (
    config.llm.default.provider === "ollama" ||
    Boolean(await getProviderKeyAsync("ollama")) ||
    Boolean(getOllamaBaseUrlEnv())
  );
}

// ── TF-IDF sparse embedding ───────────────────────────────────────
// Simple tokenizer + TF-IDF sparse encoder. Produces a SparseEmbedding
// with term indices (hashed to a fixed vocabulary) and TF-IDF weights.
// Can be upgraded to a learned sparse encoder (e.g. SPLADE) later.

export const SPARSE_VOCAB_SIZE = 30_000;

/**
 * Bump this version whenever the sparse embedding algorithm changes
 * (e.g. hash function fix, tokenizer change) to trigger re-indexing
 * of existing sparse vectors via the sentinel mismatch mechanism.
 */
export const SPARSE_EMBEDDING_VERSION = 3;

/** Tokenize text into lowercase alphanumeric tokens (Unicode-aware). */
export function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** Hash a token to a stable index in [0, vocabSize). */
export function tokenHash(token: string, vocabSize: number): number {
  // FNV-1a 32-bit hash for speed
  let hash = 0x811c9dc5;
  for (let i = 0; i < token.length; i++) {
    hash ^= token.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % vocabSize;
}

/**
 * Generate a TF-IDF-based sparse embedding for the given text.
 *
 * Term frequency is computed from the input. IDF is approximated using
 * sub-linear TF weighting (1 + log(tf)) since we don't have a corpus-level
 * document frequency table. This still produces useful sparse vectors for
 * lexical matching via Qdrant's sparse vector support.
 */
export function generateSparseEmbedding(text: string): SparseEmbedding {
  const tokens = tokenize(text);
  if (tokens.length === 0) {
    return { indices: [], values: [] };
  }

  // Count term frequencies per hash bucket
  const tf = new Map<number, number>();
  for (const token of tokens) {
    const idx = tokenHash(token, SPARSE_VOCAB_SIZE);
    tf.set(idx, (tf.get(idx) ?? 0) + 1);
  }

  // Convert to sub-linear TF weights: 1 + log(tf)
  const indices: number[] = [];
  const values: number[] = [];
  for (const [idx, count] of tf) {
    indices.push(idx);
    values.push(1 + Math.log(count));
  }

  // L2-normalize the sparse vector so scores are comparable
  let norm = 0;
  for (const v of values) norm += v * v;
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < values.length; i++) {
      values[i] /= norm;
    }
  }

  return { indices, values };
}
