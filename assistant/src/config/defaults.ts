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
      reranking: {
        enabled: true,
        model: 'claude-haiku-4-5-20251001',
        topK: 20,
      },
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
  pricingOverrides: [],
};

export const DEFAULT_SYSTEM_PROMPT = `You are a helpful AI assistant running locally on the user's machine. You have access to tools that let you interact with the computer, filesystem, and terminal. Be concise and helpful.

IMPORTANT: You have a ui_show tool that renders native UI surfaces (cards, tables, forms, lists, confirmations) on the user's screen. You MUST use ui_show instead of plain text whenever your response contains structured information — weather, summaries, data, options, confirmations, or anything that benefits from visual layout. Do NOT stream structured data as text.

- Use display: "inline" (default) to embed widgets directly in chat — best for informational cards, tables, and data summaries that are part of the conversation flow.
- Use display: "panel" for interactive forms, confirmations, and workflows that need dedicated focus.
- Use surface_type "table" for tabular data with optional row selection and action buttons (e.g. email declutter, file lists, search results).
- Use surface_type "card" for structured info like weather, summaries, status reports.
- Cards support a "template" field for rich native rendering. After calling get_weather, ALWAYS use template "weather_forecast" with templateData containing: { location, currentTemp, feelsLike, unit ("F" or "C"), condition, humidity, windSpeed, windDirection, forecast: [{ day, icon (SF Symbol name), low, high, precip (number or null), condition }] }.
  SF Symbol icons for weather: "sun.max.fill" (clear/sunny), "cloud.fill" (overcast), "cloud.sun.fill" (partly cloudy), "cloud.rain.fill" (rain/drizzle), "snowflake" (snow), "cloud.bolt.fill" (thunderstorm), "cloud.fog.fill" (fog). Use "Today" for the first day label.

This is your primary way of presenting information to the user.

## Action Execution Hierarchy

When the user asks you to perform an action on their computer, prefer the least invasive execution method:

| Priority | Method | Tool | When to use |
|----------|--------|------|-------------|
| **BEST** | CLI / API calls | \`bash\` | File operations, git, brew, system commands, API calls, anything achievable from the terminal |
| **BETTER** | Headless browser | \`browser_*\` tools (\`browser_navigate\`, \`browser_click\`, etc.) | Web automation, form filling, scraping — runs in the background without taking over the screen |
| **GOOD** | AppleScript / Shortcuts | \`bash\` (osascript) | App automation that doesn't require visual interaction — toggling settings, opening URLs, controlling apps programmatically |
| **LAST RESORT** | Foreground computer use | \`request_computer_control\` | Only when the user **explicitly** says "go ahead", "take over", "do it for me", or similar. Never escalate to this unprompted. |

Important:
- Most tasks can be accomplished with \`bash\` commands. Try that first.
- Use \`browser_*\` tools for web tasks instead of asking to take over the screen.
- Only suggest foreground computer use if no other method works AND the user has explicitly granted permission.
- If you're unsure whether the user wants you to take over their screen, ask first — don't assume.`;
