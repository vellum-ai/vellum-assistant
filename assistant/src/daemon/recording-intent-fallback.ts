// LLM-based fallback classifier for recording intent detection.
// Fires only when the deterministic resolver returns `none` but the text
// contains recording-related keywords that suggest an intent the regex missed.
// Safety: returns `{ action: 'none', confidence: 'low' }` on any failure —
// never triggers a recording action on error.

import { createTimeout, extractText, getConfiguredProvider, userMessage } from '../providers/provider-send-message.js';
import { getLogger } from '../util/logger.js';

const log = getLogger('recording-intent-fallback');

const FALLBACK_TIMEOUT_MS = 5000;

export type RecordingFallbackAction = 'start' | 'stop' | 'restart' | 'pause' | 'resume' | 'none';

export interface RecordingFallbackResult {
  action: RecordingFallbackAction;
  confidence: 'high' | 'medium' | 'low';
}

const SAFE_DEFAULT: RecordingFallbackResult = { action: 'none', confidence: 'low' };

/** Keywords that gate whether we spend an LLM call on fallback classification. */
const RECORDING_KEYWORDS = [
  'record',
  'recording',
  'screen capture',
  'screencast',
  'capture screen',
  'capture my screen',
  'screen rec',
];

const SYSTEM_PROMPT =
  'You are classifying user messages for a screen recording assistant. ' +
  'Determine if the user wants to: start a recording, stop a recording, restart a recording, ' +
  'pause a recording, resume a recording, or none of these. ' +
  'Only classify as an action if the user is giving an imperative command. ' +
  'Questions about recording (e.g., "how do I record?", "what does recording do?") should be classified as "none". ' +
  'Respond with a JSON object: {"action": "start|stop|restart|pause|resume|none", "confidence": "high|medium|low"}';

const VALID_ACTIONS = new Set<RecordingFallbackAction>(['start', 'stop', 'restart', 'pause', 'resume', 'none']);
const VALID_CONFIDENCES = new Set<string>(['high', 'medium', 'low']);

/**
 * Returns true if the text contains any recording-related keywords,
 * indicating it is worth spending an LLM call on fallback classification.
 */
export function containsRecordingKeywords(text: string): boolean {
  const lower = text.toLowerCase();
  return RECORDING_KEYWORDS.some((kw) => lower.includes(kw));
}

/**
 * Uses a lightweight LLM call to classify whether text contains a recording intent
 * that the deterministic resolver missed.
 *
 * Returns `{ action: 'none', confidence: 'high' }` for informational questions.
 * Only returns an actionable result with 'high' confidence for clear imperative commands.
 */
export async function classifyRecordingIntentFallback(
  text: string,
): Promise<RecordingFallbackResult> {
  const provider = getConfiguredProvider();
  if (!provider) {
    log.debug('No configured provider available for fallback classification');
    return SAFE_DEFAULT;
  }

  try {
    const { signal, cleanup } = createTimeout(FALLBACK_TIMEOUT_MS);
    try {
      const response = await provider.sendMessage(
        [userMessage(text)],
        [], // no tools
        SYSTEM_PROMPT,
        {
          config: {
            modelIntent: 'latency-optimized',
            max_tokens: 64,
          },
          signal,
        },
      );
      cleanup();

      const raw = extractText(response);
      return parseClassificationResponse(raw);
    } finally {
      cleanup();
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn({ err: message }, 'LLM fallback classification failed');
    return SAFE_DEFAULT;
  }
}

/**
 * Parse the LLM's JSON response into a validated RecordingFallbackResult.
 * Returns safe default on any parse/validation failure.
 */
function parseClassificationResponse(raw: string): RecordingFallbackResult {
  try {
    // Extract JSON from the response — the LLM may include surrounding text
    const jsonMatch = raw.match(/\{[^}]*\}/);
    if (!jsonMatch) {
      log.debug({ raw }, 'No JSON object found in LLM fallback response');
      return SAFE_DEFAULT;
    }

    const parsed = JSON.parse(jsonMatch[0]) as { action?: string; confidence?: string };

    const action = parsed.action as RecordingFallbackAction | undefined;
    const confidence = parsed.confidence;

    if (!action || !VALID_ACTIONS.has(action)) {
      log.debug({ raw, action }, 'Invalid action in LLM fallback response');
      return SAFE_DEFAULT;
    }

    if (!confidence || !VALID_CONFIDENCES.has(confidence)) {
      log.debug({ raw, confidence }, 'Invalid confidence in LLM fallback response');
      return SAFE_DEFAULT;
    }

    return { action, confidence: confidence as RecordingFallbackResult['confidence'] };
  } catch (err) {
    log.debug({ err, raw }, 'Failed to parse LLM fallback response as JSON');
    return SAFE_DEFAULT;
  }
}
