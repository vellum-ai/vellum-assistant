/**
 * Per-turn response tier classification.
 *
 * Classifies each user message into a tier that controls:
 * - maxTokens budget for the LLM response
 * - Which system prompt sections are included
 *
 * The classifier is deterministic (pure regex/heuristic) so it adds
 * zero latency to the critical path.
 */

import { getLogger } from '../util/logger.js';

const log = getLogger('response-tier');

export type ResponseTier = 'low' | 'medium' | 'high';

// ── Patterns ──────────────────────────────────────────────────────────

const GREETING_PATTERNS = /^(hey|hi|hello|yo|sup|hiya|howdy|what'?s up|thanks|thank you|thx|ty|cheers|what can you|who are you|how are you)\b/i;

const BUILD_KEYWORDS = /\b(build|implement|create|refactor|debug|deploy|migrate|scaffold|architect|redesign|generate|write|develop|fix|convert|add|remove|update|modify|change|delete|replace|integrate|setup|install|configure|optimize|rewrite)\b/i;

const CODE_FENCE = /```/;
const FILE_PATH = /(?:^|[\s"'(])(?:\/|~\/|\.\/)\S/;
const MULTI_PARAGRAPH = /\n\s*\n/;

/**
 * Classify the complexity tier of a user message.
 *
 * Priority: high signals checked first, then low signals. Everything
 * else falls through to medium.
 */
export function classifyResponseTier(message: string, _turnCount: number): ResponseTier {
  const trimmed = message.trim();
  const len = trimmed.length;

  // Polite imperative: "can you build...", "could you create...", "would you implement..."
  // These are requests, not questions — treat them like imperatives.
  const isPoliteImperative = /^(can|could|would|will)\s+you\s+/i.test(trimmed) && BUILD_KEYWORDS.test(trimmed);

  const isQuestion = !isPoliteImperative && (
    /\?$/.test(trimmed) || /^(what|who|where|when|why|how|which|can|could|should|would|is|are|do|does|did|will|has|have)\b/i.test(trimmed)
  );

  // ── High signals (any match → high) ──
  if (len > 500) return tagged('high', 'length>500');
  if (CODE_FENCE.test(trimmed)) return tagged('high', 'code_fence');
  if (FILE_PATH.test(trimmed)) return tagged('high', 'file_path');
  if (MULTI_PARAGRAPH.test(trimmed)) return tagged('high', 'multi_paragraph');
  if (!isQuestion && BUILD_KEYWORDS.test(trimmed)) return tagged('high', 'build_keyword');

  // ── Low signals (any match → low) ──
  if (GREETING_PATTERNS.test(trimmed)) return tagged('low', 'greeting');
  if (len < 80 && !BUILD_KEYWORDS.test(trimmed)) return tagged('low', 'short_no_keywords');

  // ── Default ──
  return tagged('medium', 'default');
}

function tagged(tier: ResponseTier, reason: string): ResponseTier {
  log.debug({ tier, reason }, 'Classified response tier');
  return tier;
}

// ── Token scaling ─────────────────────────────────────────────────────

const TIER_SCALE: Record<ResponseTier, number> = {
  low: 0.125,
  medium: 0.5,
  high: 1,
};

/**
 * Scale the configured max tokens ceiling by the tier multiplier.
 *
 * Examples with configuredMax = 16000:
 *   low    → 2000
 *   medium → 8000
 *   high   → 16000
 */
export function tierMaxTokens(tier: ResponseTier, configuredMax: number): number {
  return Math.round(configuredMax * TIER_SCALE[tier]);
}

// ── Model routing ─────────────────────────────────────────────────────

/**
 * Map for Anthropic provider: tier → model.
 *   low    → haiku (fastest TTFT)
 *   medium → sonnet (balanced)
 *   high   → undefined (use configured default, typically opus)
 */
const ANTHROPIC_TIER_MODELS: Record<ResponseTier, string | undefined> = {
  low: 'claude-haiku-4-5-20251001',
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
