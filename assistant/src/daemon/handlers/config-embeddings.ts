import {
  getConfig,
  loadRawConfig,
  saveRawConfig,
} from "../../config/loader.js";
import { setMemoryEmbeddingField } from "../../config/raw-config-utils.js";
import { VALID_MEMORY_EMBEDDING_PROVIDERS } from "../../config/schemas/memory-storage.js";
import {
  clearEmbeddingBackendCache,
  getMemoryBackendStatus,
} from "../../memory/embedding-backend.js";
import type { ModelSetContext } from "./config-model.js";
import { CONFIG_RELOAD_DEBOUNCE_MS, log } from "./shared.js";

// ---------------------------------------------------------------------------
// Embedding provider catalog
// ---------------------------------------------------------------------------

const EMBEDDING_PROVIDER_CATALOG = [
  {
    id: "auto",
    displayName: "Auto (Best Available)",
    defaultModel: "",
    requiresKey: false,
  },
  {
    id: "local",
    displayName: "Local (In-Process)",
    defaultModel: "Xenova/bge-small-en-v1.5",
    requiresKey: false,
  },
  {
    id: "openai",
    displayName: "OpenAI",
    defaultModel: "text-embedding-3-small",
    requiresKey: true,
  },
  {
    id: "gemini",
    displayName: "Gemini",
    defaultModel: "gemini-embedding-2-preview",
    requiresKey: true,
  },
  {
    id: "ollama",
    displayName: "Ollama",
    defaultModel: "nomic-embed-text",
    requiresKey: false,
  },
];

// ---------------------------------------------------------------------------
// Provider-specific model field names
// ---------------------------------------------------------------------------

const PROVIDER_MODEL_FIELD: Record<string, string> = {
  local: "localModel",
  openai: "openaiModel",
  gemini: "geminiModel",
  ollama: "ollamaModel",
};

// ---------------------------------------------------------------------------
// GET — return current embedding config + resolved status
// ---------------------------------------------------------------------------

export async function getEmbeddingConfigInfo(): Promise<{
  provider: string;
  model: string | null;
  activeProvider: string | null;
  activeModel: string | null;
  availableProviders: typeof EMBEDDING_PROVIDER_CATALOG;
  status: { enabled: boolean; degraded: boolean; reason: string | null };
}> {
  const config = getConfig();
  const embeddingConfig = config.memory.embeddings;
  const backendStatus = await getMemoryBackendStatus(config);

  // Derive the provider-specific model from config
  const fieldName = PROVIDER_MODEL_FIELD[embeddingConfig.provider];
  const model = fieldName
    ? (embeddingConfig as Record<string, unknown>)[fieldName]
    : null;

  return {
    provider: embeddingConfig.provider,
    model: typeof model === "string" ? model : null,
    activeProvider: backendStatus.provider,
    activeModel: backendStatus.model,
    availableProviders: EMBEDDING_PROVIDER_CATALOG,
    status: {
      enabled: backendStatus.enabled,
      degraded: backendStatus.degraded,
      reason: backendStatus.reason,
    },
  };
}

// ---------------------------------------------------------------------------
// PUT — persist embedding provider/model to config
// ---------------------------------------------------------------------------

export async function setEmbeddingConfig(
  provider: string,
  model: string | undefined,
  ctx: ModelSetContext,
): Promise<ReturnType<typeof getEmbeddingConfigInfo>> {
  const validProviders = new Set<string>(VALID_MEMORY_EMBEDDING_PROVIDERS);
  if (!validProviders.has(provider)) {
    throw new Error(
      `Invalid embedding provider "${provider}". Valid providers: ${[...validProviders].join(", ")}`,
    );
  }

  const raw = loadRawConfig();
  setMemoryEmbeddingField(raw, "provider", provider);

  if (model !== undefined) {
    const fieldName = PROVIDER_MODEL_FIELD[provider];
    if (fieldName) {
      setMemoryEmbeddingField(raw, fieldName, model);
    }
  }

  // Suppress the file watcher callback — we handle the reload ourselves.
  const wasSuppressed = ctx.suppressConfigReload;
  ctx.setSuppressConfigReload(true);
  try {
    saveRawConfig(raw);
  } catch (err) {
    ctx.setSuppressConfigReload(wasSuppressed);
    throw err;
  }
  ctx.debounceTimers.schedule(
    "__suppress_reset__",
    () => {
      ctx.setSuppressConfigReload(false);
    },
    CONFIG_RELOAD_DEBOUNCE_MS,
  );

  clearEmbeddingBackendCache();
  ctx.updateConfigFingerprint();

  log.info({ provider, model }, "Embedding config updated");

  return getEmbeddingConfigInfo();
}
