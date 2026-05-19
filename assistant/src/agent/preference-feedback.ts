/**
 * Post-turn preference-feedback observer.
 *
 * After each assistant turn, the observer classifies the just-completed
 * exchange and reinforces or contradicts learned preferences. Judgement is
 * model-mediated per the "Assistant-Driven Judgement" rule — we do not
 * pattern-match user text to infer preference signals.
 *
 * Feature-flag gated by `memory-maturation`. When disabled the observer
 * short-circuits before any LLM call, so callers can safely invoke it on
 * every turn without coordinating the flag check at the call site.
 */

import { z } from "zod";

import { isAssistantFeatureFlagEnabled } from "../config/assistant-feature-flags.js";
import { getConfig } from "../config/loader.js";
import {
  listPkbPreferences,
  type PreferenceSignal,
  upsertPkbPreference,
} from "../memory/personal-knowledge-store.js";
import { getConfiguredProvider } from "../providers/provider-send-message.js";
import type { Provider } from "../providers/types.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("preference-feedback");

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface PreferenceFeedbackTurn {
  /**
   * The user's latest message (already-sanitised plain text). Pass a short
   * excerpt — the observer caps the payload size on its own.
   */
  userText: string;
  /**
   * The assistant's latest reply (already-sanitised plain text). Empty/null
   * skips the observer.
   */
  assistantText: string;
  /** Optional scope override; defaults to the PKB default scope. */
  scopeId?: string;
}

export interface PreferenceFeedbackResult {
  /** True when the observer made at least one PKB write. */
  applied: boolean;
  /** Preference keys reinforced as a `positive` signal. */
  reinforced: string[];
  /** Preference keys flipped as a `negative` signal. */
  contradicted: string[];
  /** Newly inferred preferences (key/value). */
  inferred: Array<{ key: string; value: string }>;
}

export interface PreferenceFeedbackOptions {
  /** Override provider resolution for tests. */
  getProvider?: () => Promise<Provider | null>;
  /** Override flag resolution for tests. */
  isEnabled?: () => boolean;
  /** Hard timeout for the LLM call, defaults to 8s. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_PREFERENCES_IN_PROMPT = 25;
const MAX_USER_TEXT_LEN = 1_000;
const MAX_ASSISTANT_TEXT_LEN = 1_000;

const PREFERENCE_FEEDBACK_PROMPT = `You are the assistant's preference-learning subsystem.

You are given:
- A list of preferences the assistant currently believes about the user (key + value).
- The most recent user message and assistant reply.

Your job is to identify whether any preferences were reinforced or contradicted in this exchange, and whether any *new* preferences are clearly stated by the user.

Rules:
- Only act on explicit or clearly implied signal from the user. Do not speculate.
- "reinforced": the user behaved consistently with the stored value (e.g. asked for concise output when "communication-style" = "concise").
- "contradicted": the user contradicted the stored value (e.g. asked for verbose output when stored value is "concise"). Include the new value the user prefers in 'value'.
- "inferred": brand-new preferences clearly stated by the user this turn.
- Reuse existing keys when possible. Use kebab-case for new keys.

Return ONLY valid JSON, no prose. Schema:
{
  "reinforced": [{"key": "..."}],
  "contradicted": [{"key": "...", "value": "..."}],
  "inferred": [{"key": "...", "value": "..."}]
}

If nothing applies, return: {"reinforced": [], "contradicted": [], "inferred": []}`;

const FeedbackDecisionSchema = z.object({
  reinforced: z
    .array(z.object({ key: z.string().min(1).max(120) }))
    .max(20)
    .default([]),
  contradicted: z
    .array(
      z.object({
        key: z.string().min(1).max(120),
        value: z.string().min(1).max(400),
      }),
    )
    .max(20)
    .default([]),
  inferred: z
    .array(
      z.object({
        key: z.string().min(1).max(120),
        value: z.string().min(1).max(400),
      }),
    )
    .max(20)
    .default([]),
});

const EMPTY_RESULT: PreferenceFeedbackResult = {
  applied: false,
  reinforced: [],
  contradicted: [],
  inferred: [],
};

export async function runPreferenceFeedback(
  turn: PreferenceFeedbackTurn,
  options: PreferenceFeedbackOptions = {},
): Promise<PreferenceFeedbackResult> {
  const isEnabled =
    options.isEnabled ??
    (() => isAssistantFeatureFlagEnabled("memory-maturation", getConfig()));
  if (!isEnabled()) return EMPTY_RESULT;

  const userText = clipText(turn.userText, MAX_USER_TEXT_LEN);
  const assistantText = clipText(turn.assistantText, MAX_ASSISTANT_TEXT_LEN);
  if (!userText || !assistantText) return EMPTY_RESULT;

  const provider = await (options.getProvider
    ? options.getProvider()
    : getConfiguredProvider("preferenceFeedback"));
  if (!provider) return EMPTY_RESULT;

  const stored = listPkbPreferences({
    scopeId: turn.scopeId,
    limit: MAX_PREFERENCES_IN_PROMPT,
  });
  const storedSummary = stored.map((row) => ({
    key: row.key,
    value: row.value,
  }));

  const prompt = JSON.stringify(
    {
      stored: storedSummary,
      userText,
      assistantText,
    },
    null,
    2,
  );

  let decoded: z.infer<typeof FeedbackDecisionSchema>;
  try {
    const response = await provider.sendMessage(
      [{ role: "user", content: [{ type: "text", text: prompt }] }],
      undefined,
      PREFERENCE_FEEDBACK_PROMPT,
      {
        signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        config: { callSite: "preferenceFeedback", max_tokens: 384 },
      },
    );
    const text = response.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();
    const parsedJson = parseJsonObjectFromText(text);
    const parsed = FeedbackDecisionSchema.safeParse(parsedJson);
    if (!parsed.success) {
      log.debug({ issues: parsed.error.issues }, "feedback decision malformed");
      return EMPTY_RESULT;
    }
    decoded = parsed.data;
  } catch (err) {
    log.debug({ err }, "preference feedback classification failed");
    return EMPTY_RESULT;
  }

  const knownKeys = new Set(stored.map((row) => row.key));
  const reinforced: string[] = [];
  const contradicted: string[] = [];
  const inferred: Array<{ key: string; value: string }> = [];

  for (const entry of decoded.reinforced) {
    if (!knownKeys.has(entry.key)) continue;
    const existing = stored.find((row) => row.key === entry.key);
    if (!existing) continue;
    try {
      upsertPkbPreference({
        scopeId: turn.scopeId,
        key: entry.key,
        value: existing.value,
        learnedFrom: "preference-feedback",
        signal: "positive",
      });
      reinforced.push(entry.key);
    } catch (err) {
      log.warn({ err, key: entry.key }, "failed to reinforce preference");
    }
  }

  for (const entry of decoded.contradicted) {
    if (!knownKeys.has(entry.key)) continue;
    try {
      upsertPkbPreference({
        scopeId: turn.scopeId,
        key: entry.key,
        value: entry.value,
        learnedFrom: "preference-feedback",
        signal: "negative" as PreferenceSignal,
      });
      contradicted.push(entry.key);
    } catch (err) {
      log.warn({ err, key: entry.key }, "failed to contradict preference");
    }
  }

  for (const entry of decoded.inferred) {
    if (knownKeys.has(entry.key)) continue;
    try {
      upsertPkbPreference({
        scopeId: turn.scopeId,
        key: entry.key,
        value: entry.value,
        learnedFrom: "preference-feedback",
        signal: "positive",
      });
      inferred.push({ key: entry.key, value: entry.value });
    } catch (err) {
      log.warn({ err, key: entry.key }, "failed to record inferred preference");
    }
  }

  const applied = reinforced.length + contradicted.length + inferred.length > 0;
  return { applied, reinforced, contradicted, inferred };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clipText(value: string | undefined, limit: number): string {
  if (!value) return "";
  const trimmed = value.trim();
  if (trimmed.length <= limit) return trimmed;
  return trimmed.slice(0, limit);
}

function parseJsonObjectFromText(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenceMatch ? fenceMatch[1].trim() : trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    const objectMatch = candidate.match(/\{[\s\S]*\}/);
    if (!objectMatch) return null;
    try {
      return JSON.parse(objectMatch[0]);
    } catch {
      return null;
    }
  }
}
