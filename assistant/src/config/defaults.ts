import { getDataDir } from '../util/platform.js';
import type { AssistantConfig } from './types.js';

export const DEFAULT_CONFIG: AssistantConfig = {
  provider: 'anthropic',
  model: 'claude-opus-4-6', // alias: claude-opus-4
  apiKeys: {},
  maxTokens: 64000,
  thinking: {
    enabled: false,
    budgetTokens: 10000,
  },
  contextWindow: {
    enabled: true,
    maxInputTokens: 180000,
    targetInputTokens: 110000,
    compactThreshold: 0.8,
    preserveRecentUserTurns: 8,
    summaryMaxTokens: 1200,
    chunkTokens: 12000,
  },
  memory: {
    enabled: true,
    embeddings: {
      required: true,
      provider: 'auto',
      localModel: 'Xenova/bge-small-en-v1.5',
      openaiModel: 'text-embedding-3-small',
      geminiModel: 'gemini-embedding-001',
      ollamaModel: 'nomic-embed-text',
    },
    qdrant: {
      url: 'http://127.0.0.1:6333',
      collection: 'memory',
      vectorSize: 384,
      onDisk: true,
      quantization: 'scalar',
    },
    retrieval: {
      lexicalTopK: 80,
      semanticTopK: 40,
      maxInjectTokens: 10000,
      injectionFormat: 'markdown' as const,
      injectionStrategy: 'prepend_user_block' as const,
      reranking: {
        enabled: true,
        model: 'claude-haiku-4-5-20251001',
        topK: 20,
      },
      freshness: {
        enabled: true,
        maxAgeDays: { fact: 0, preference: 0, behavior: 90, event: 30, opinion: 60 },
        staleDecay: 0.5,
        reinforcementShieldDays: 7,
      },
      scopePolicy: 'allow_global_fallback' as const,
    },
    segmentation: {
      targetTokens: 450,
      overlapTokens: 60,
    },
    jobs: {
      workerConcurrency: 2,
    },
    retention: {
      keepRawForever: true,
    },
    extraction: {
      useLLM: true,
      model: 'claude-haiku-4-5-20251001',
      extractFromAssistant: true,
    },
    summarization: {
      useLLM: true,
      model: 'claude-haiku-4-5-20251001',
    },
    entity: {
      enabled: true,
      model: 'claude-haiku-4-5-20251001',
    },
  },
  dataDir: getDataDir(),
  timeouts: {
    shellDefaultTimeoutSec: 120,
    shellMaxTimeoutSec: 600,
    permissionTimeoutSec: 300,
  },
  sandbox: {
    enabled: true,
    // Default to 'native' (macOS sandbox-exec). Docker backend is available as
    // opt-in hardening for environments where stronger isolation is needed, but
    // requires Docker Desktop/Engine — a dependency most developers won't have.
    // See SANDBOX M11 decision: native remains the default until Docker
    // integration is stable, startup UX is acceptable, and host tool workflows
    // have no regressions.
    backend: 'native',
    docker: {
      image: 'node:20-slim@sha256:a22f79e64de59efd3533828aecc9817bfdc97d3b4a58f0fc1b7b33a5e2b4d5f9',
      cpus: 1,
      memoryMb: 512,
      pidsLimit: 256,
      network: 'none' as const,
    },
  },
  rateLimit: {
    maxRequestsPerMinute: 0,
    maxTokensPerSession: 0,
  },
  secretDetection: {
    enabled: true,
    action: 'warn',
    entropyThreshold: 4.0,
  },
  auditLog: {
    retentionDays: 0,
  },
  pricingOverrides: [],
  skills: {
    entries: {},
    load: { extraDirs: [], watch: true, watchDebounceMs: 250 },
    install: { nodeManager: 'npm' },
    allowBundled: null,
  },
};
