import { getDataDir } from '../util/platform.js';
import type { AssistantConfig } from './types.js';

export const DEFAULT_CONFIG: AssistantConfig = {
  provider: 'anthropic',
  model: 'claude-opus-4-6', // alias: claude-opus-4
  imageGenModel: 'gemini-2.5-flash-image',
  apiKeys: {},
  webSearchProvider: 'perplexity',
  providerOrder: [],
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
      dynamicBudget: {
        enabled: true,
        minInjectTokens: 1200,
        maxInjectTokens: 10000,
        targetHeadroomTokens: 10000,
      },
      earlyTermination: {
        enabled: true,
        minCandidates: 20,
        minHighConfidence: 10,
        confidenceThreshold: 0.7,
      },
    },
    segmentation: {
      targetTokens: 450,
      overlapTokens: 60,
    },
    jobs: {
      workerConcurrency: 2,
      batchSize: 10,
    },
    retention: {
      keepRawForever: true,
    },
    cleanup: {
      enabled: true,
      enqueueIntervalMs: 6 * 60 * 60 * 1000,
      resolvedConflictRetentionMs: 30 * 24 * 60 * 60 * 1000,
      supersededItemRetentionMs: 30 * 24 * 60 * 60 * 1000,
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
      extractRelations: {
        enabled: true,
        backfillBatchSize: 200,
      },
      relationRetrieval: {
        enabled: true,
        maxSeedEntities: 8,
        maxNeighborEntities: 20,
        maxEdges: 40,
        neighborScoreMultiplier: 0.7,
        maxDepth: 3,
        depthDecay: true,
      },
    },
    conflicts: {
      enabled: true,
      gateMode: 'soft',
      reaskCooldownTurns: 3,
      resolverLlmTimeoutMs: 12000,
      relevanceThreshold: 0.3,
      askOnIrrelevantTurns: false,
      conflictableKinds: ['preference', 'profile', 'constraint', 'instruction', 'style'],
    },
    profile: {
      enabled: true,
      maxInjectTokens: 800,
    },
  },
  dataDir: getDataDir(),
  timeouts: {
    shellDefaultTimeoutSec: 120,
    shellMaxTimeoutSec: 600,
    permissionTimeoutSec: 300,
    toolExecutionTimeoutSec: 120,
    providerStreamTimeoutSec: 300,
  },
  sandbox: {
    enabled: true,
    // SANDBOX M11 cutover: Docker is now the default backend. It provides
    // stronger container-level isolation via ephemeral containers. Docker
    // Desktop/Engine must be installed and running. Users without Docker can
    // opt into the native backend via `sandbox.backend = "native"`.
    backend: 'docker',
    docker: {
      image: 'vellum-sandbox:latest',
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
    action: 'redact',
    entropyThreshold: 4.0,
    allowOneTimeSend: false,
    blockIngress: true,
  },
  permissions: {
    mode: 'workspace',
  },
  auditLog: {
    retentionDays: 0,
  },
  logFile: {
    dir: undefined,
    retentionDays: 30,
  },
  pricingOverrides: [],
  agentHeartbeat: {
    enabled: false,
    intervalMs: 3_600_000,
  },
  swarm: {
    enabled: true,
    maxWorkers: 3,
    maxTasks: 8,
    maxRetriesPerTask: 1,
    workerTimeoutSec: 900,
    plannerModel: 'claude-haiku-4-5-20251001',
    synthesizerModel: 'claude-sonnet-4-6',
  },
  skills: {
    entries: {},
    load: { extraDirs: [], watch: true, watchDebounceMs: 250 },
    install: { nodeManager: 'npm' },
    allowBundled: null,
  },
  workspaceGit: {
    turnCommitMaxWaitMs: 4000,
    failureBackoffBaseMs: 2000,
    failureBackoffMaxMs: 60000,
    interactiveGitTimeoutMs: 10000,
    enrichmentQueueSize: 50,
    enrichmentConcurrency: 1,
    enrichmentJobTimeoutMs: 30000,
    enrichmentMaxRetries: 2,
    commitMessageLLM: {
      enabled: false,
      useConfiguredProvider: true,
      providerFastModelOverrides: {},
      timeoutMs: 600,
      maxTokens: 120,
      temperature: 0.2,
      maxFilesInPrompt: 30,
      maxDiffBytes: 12000,
      minRemainingTurnBudgetMs: 1000,
      breaker: {
        openAfterFailures: 3,
        backoffBaseMs: 2000,
        backoffMaxMs: 60000,
      },
    },
  },
  calls: {
    enabled: true,
    provider: 'twilio' as const,
    maxDurationSeconds: 3600,
    userConsultTimeoutSeconds: 120,
    disclosure: {
      enabled: true,
      text: 'At the very beginning of the call, introduce yourself as an assistant calling on behalf of the person you represent. Do not say "AI assistant".',
    },
    safety: {
      denyCategories: [],
    },
    voice: {
      mode: 'twilio_standard' as const,
      language: 'en-US',
      transcriptionProvider: 'Deepgram' as const,
      fallbackToStandardOnError: true,
      elevenlabs: {
        voiceId: '',
        voiceModelId: '',
        speed: 1.0,
        stability: 0.5,
        similarityBoost: 0.75,
        useSpeakerBoost: true,
        agentId: '',
        apiBaseUrl: 'https://api.elevenlabs.io',
        registerCallTimeoutMs: 5000,
      },
    },
    model: undefined,
    callerIdentity: {
      allowPerCallOverride: true,
    },
  },
  qaRecording: {
    defaultRetentionDays: 7,
    cleanupIntervalMs: 6 * 60 * 60 * 1000, // 6 hours
    captureScope: 'display' as const,
    includeAudio: false,
    enforceStartBeforeActions: true,
  },
  sms: {
    enabled: false,
    provider: 'twilio' as const,
    phoneNumber: '',
  },
  ingress: {
    enabled: undefined,
    publicBaseUrl: '',
  },
};
