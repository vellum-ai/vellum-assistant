/**
 * Per-turn response tier classification.
 *
 * Classifies each user message into a tier that controls:
 * - maxTokens budget for the LLM response
 * - Which system prompt sections are included
 *
 * Two layers:
 * 1. Deterministic regex/heuristic (zero latency, runs every turn)
 * 2. Background Haiku classification (fire-and-forget, advises future turns)
 */

import { createTimeout, extractText, getConfiguredProvider, userMessage } from '../providers/provider-send-message.js';
import { getLogger } from '../util/logger.js';

const log = getLogger('response-tier');

export type ResponseTier = 'low' | 'medium' | 'high';

export type TierConfidence = 'high' | 'low';

export interface TierClassification {
  tier: ResponseTier;
  reason: string;
  confidence: TierConfidence;
}

export interface SessionTierHint {
  tier: ResponseTier;
  turn: number;
  timestamp: number;
}

// ── Patterns ──────────────────────────────────────────────────────────

const GREETING_PATTERNS = /^(hey|hi|hello|yo|sup|hiya|howdy|what'?s up|thanks|thank you|thx|ty|cheers|what can you|who are you|how are you)\b/i;

const BUILD_KEYWORDS = /\b(build|implement|create|refactor|debug|deploy|migrate|scaffold|architect|redesign|generate|write|develop|fix|convert|add|remove|update|modify|change|delete|replace|integrate|setup|install|configure|optimize|rewrite)\b/i;

const CODE_FENCE = /```/;
const FILE_PATH = /(?:^|[\s"'(])(?:\/|~\/|\.\/)\S/;
const MULTI_PARAGRAPH = /\n\s*\n/;

// ── Confidence thresholds ─────────────────────────────────────────────

const HINT_MAX_TURN_AGE = 4;
const HINT_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Classify the complexity tier of a user message (backward-compat wrapper).
 */
export function classifyResponseTier(message: string, _turnCount: number): ResponseTier {
  return classifyResponseTierDetailed(message, _turnCount).tier;
}

/**
 * Classify with confidence scoring. High confidence means the regex
 * matched an unambiguous signal; low confidence means the message
 * fell through to the default medium bucket.
 */
export function classifyResponseTierDetailed(message: string, _turnCount: number): TierClassification {
  const trimmed = message.trim();
  const len = trimmed.length;

  const isPoliteImperative = /^(can|could|would|will)\s+you\s+/i.test(trimmed) && BUILD_KEYWORDS.test(trimmed);

  const isQuestion = !isPoliteImperative && (
    /\?$/.test(trimmed) || /^(what|who|where|when|why|how|which|can|could|should|would|is|are|do|does|did|will|has|have)\b/i.test(trimmed)
  );

  // ── High signals (any match → high tier, high confidence) ──
  if (len > 500) return tagged('high', 'length>500', 'high');
  if (CODE_FENCE.test(trimmed)) return tagged('high', 'code_fence', 'high');
  if (FILE_PATH.test(trimmed)) return tagged('high', 'file_path', 'high');
  if (MULTI_PARAGRAPH.test(trimmed)) return tagged('high', 'multi_paragraph', 'high');
  if (!isQuestion && BUILD_KEYWORDS.test(trimmed)) return tagged('high', 'build_keyword', 'high');

  // ── Low signals (any match → low tier, high confidence) ──
  if (GREETING_PATTERNS.test(trimmed) && len < 40 && !BUILD_KEYWORDS.test(trimmed)) return tagged('low', 'greeting', 'high');
  if (len < 80 && !BUILD_KEYWORDS.test(trimmed)) return tagged('low', 'short_no_keywords', 'high');

  // ── Default (low confidence — ambiguous) ──
  return tagged('medium', 'default', 'low');
}

const TIER_RANK: Record<ResponseTier, number> = { low: 0, medium: 1, high: 2 };

/**
 * Resolve the final tier using the regex classification and an optional
 * session hint from a previous background Haiku call.
 *
 * - When confidence is low, defer to a fresh hint (upgrade or downgrade).
 * - When confidence is high, still upgrade if the hint is higher (the
 *   conversation trajectory outranks a short-message heuristic), but
 *   never downgrade.
 */
export function resolveWithHint(
  classification: TierClassification,
  hint: SessionTierHint | null,
  currentTurn: number,
): ResponseTier {
  if (!hint) {
    return classification.tier;
  }

  const turnAge = currentTurn - hint.turn;
  const timeAge = Date.now() - hint.timestamp;

  if (turnAge > HINT_MAX_TURN_AGE || timeAge > HINT_MAX_AGE_MS) {
    log.debug({ turnAge, timeAge }, 'Session tier hint is stale, ignoring');
    return classification.tier;
  }

  if (classification.confidence === 'low') {
    // Low confidence: fully defer to hint
    log.info(
      { regexTier: classification.tier, hintTier: hint.tier, turnAge },
      'Deferring to session tier hint (low confidence)',
    );
    return hint.tier;
  }

  // High confidence: only upgrade, never downgrade
  if (TIER_RANK[hint.tier] > TIER_RANK[classification.tier]) {
    log.info(
      { regexTier: classification.tier, hintTier: hint.tier, turnAge },
      'Upgrading tier via session hint',
    );
    return hint.tier;
  }

  return classification.tier;
}

// ── Async Haiku classification ────────────────────────────────────────

const ASYNC_CLASSIFICATION_TIMEOUT_MS = 8_000;

const TIER_SYSTEM_PROMPT =
  'Classify the overall complexity of this conversation. ' +
  'Output ONLY one word, nothing else.\n' +
  'low — greetings, thanks, short acknowledgements\n' +
  'medium — simple questions, short requests, clarifications\n' +
  'high — build/implement/refactor requests, multi-step tasks, code-heavy work';

/**
 * Fire-and-forget Haiku call to classify the conversation trajectory.
 * Returns the classified tier, or undefined when no provider is configured
 * or on any failure.
 */
export async function classifyResponseTierAsync(
  recentUserTexts: string[],
): Promise<ResponseTier | undefined> {
  const provider = getConfiguredProvider();
  if (!provider) {
    log.debug('No provider available for async tier classification');
    return undefined;
  }

  const combined = recentUserTexts
    .map((t, i) => `[Message ${i + 1}]: ${t}`)
    .join('\n');

  try {
    const { signal, cleanup } = createTimeout(ASYNC_CLASSIFICATION_TIMEOUT_MS);
    try {
      const response = await provider.sendMessage(
        [userMessage(combined)],
        undefined,
        TIER_SYSTEM_PROMPT,
        {
          config: {
            modelIntent: 'latency-optimized',
            max_tokens: 8,
          },
          signal,
        },
      );
      cleanup();

      const raw = extractText(response).toLowerCase();
      const match = raw.match(/\b(low|medium|high)\b/);
      if (match) {
        const tier = match[1] as ResponseTier;
        log.debug({ tier, raw }, 'Async tier classification result');
        return tier;
      }

      log.debug({ raw }, 'Async tier classification returned unexpected value');
      return undefined;
    } finally {
      cleanup();
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.debug({ err: message }, 'Async tier classification failed');
    return undefined;
  }
}

function tagged(tier: ResponseTier, reason: string, confidence: TierConfidence): TierClassification {
  log.debug({ tier, reason, confidence }, 'Classified response tier');
  return { tier, reason, confidence };
}

// ── Token scaling ─────────────────────────────────────────────────────

const TIER_SCALE: Record<ResponseTier, number> = {
  low: 0.125,
  medium: 0.375,
  high: 1,
};

/**
 * Scale the configured max tokens ceiling by the tier multiplier.
 *
 * Examples with configuredMax = 16000:
 *   low    → 2000
 *   medium → 6000
 *   high   → 16000
 */
export function tierMaxTokens(tier: ResponseTier, configuredMax: number): number {
  return Math.round(configuredMax * TIER_SCALE[tier]);
}

// ── Model routing ─────────────────────────────────────────────────────

/**
 * Map for Anthropic provider: tier → model.
 *   low    → sonnet (balanced)
 *   medium → sonnet (balanced)
 *   high   → undefined (use configured default, typically opus)
 */
const ANTHROPIC_TIER_MODELS: Record<ResponseTier, string | undefined> = {
  low: 'claude-sonnet-4-6',
  medium: 'claude-sonnet-4-6',
  high: undefined, // use configured default
};

/**
 * Returns a model override for the given tier, or undefined to use the
 * provider's configured default. Only applies model downgrading for
 * the Anthropic provider.
 */
export function tierModel(tier: ResponseTier, providerName: string): string | undefined {
  if (providerName !== 'anthropic') return undefined;
  return ANTHROPIC_TIER_MODELS[tier];
}
