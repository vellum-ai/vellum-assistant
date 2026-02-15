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
    // SANDBOX M11 cutover: Docker is now the default backend. It provides
    // stronger container-level isolation via ephemeral containers. Docker
    // Desktop/Engine must be installed and running. Users without Docker can
    // opt into the native backend via `sandbox.backend = "native"`.
    backend: 'docker',
    docker: {
      image: 'node:20-slim@sha256:c6585df72c34172bebd8d36abed961e231d7d3b5cee2e01294c4495e8a03f687',
      shell: 'bash',
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
