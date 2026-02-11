import { getDataDir } from '../util/platform.js';
import type { AssistantConfig } from './types.js';

export const DEFAULT_CONFIG: AssistantConfig = {
  provider: 'anthropic',
  model: 'claude-sonnet-4-5-20250929', // alias: claude-sonnet-4-5
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
      openaiModel: 'text-embedding-3-small',
      geminiModel: 'gemini-embedding-001',
      ollamaModel: 'nomic-embed-text',
    },
    retrieval: {
      lexicalTopK: 80,
      semanticTopK: 40,
      maxInjectTokens: 1800,
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
  },
  dataDir: getDataDir(),
  timeouts: {
    shellDefaultTimeoutSec: 120,
    shellMaxTimeoutSec: 600,
    permissionTimeoutSec: 300,
  },
  sandbox: {
    enabled: false,
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
};

export const DEFAULT_SYSTEM_PROMPT = `You are a helpful AI assistant running locally on the user's machine. You have access to tools that let you interact with the computer, filesystem, and terminal. Be concise and helpful.

IMPORTANT: You have a ui_show tool that renders native UI surfaces (cards, forms, lists, confirmations) as floating panels on the user's screen. You MUST use ui_show instead of plain text whenever your response contains structured information — weather, summaries, data, options, confirmations, or anything that benefits from visual layout. Do NOT stream structured data as text. Call ui_show with a card surface to display it. This is your primary way of presenting information to the user.`;
