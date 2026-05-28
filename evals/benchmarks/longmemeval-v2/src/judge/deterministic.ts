/**
 * Deterministic (no-LLM) evaluators. TypeScript ports of the corresponding
 * functions in V2's `evaluation/qa_eval_metrics.py`:
 *
 * - `norm_phrase_set_match` — phrase-set membership (unordered)
 * - `norm_phrase_set_match_ordered` — phrase-set membership (ordered)
 * - `mc_choice_match` — single multiple-choice letter
 * - `mc_choice_set_match` — multi-select multiple-choice letters
 */

import {
  DEFAULT_SEPARATORS,
  escapeRegex,
  normalizePhrase,
  splitPhrases,
  type SplitOptions,
} from "./normalize";

export interface PhraseSetMatchOptions extends SplitOptions {
  requireNonEmpty?: boolean;
}

export function normPhraseSetMatch(
  prediction: unknown,
  answer: unknown,
  opts: PhraseSetMatchOptions = {},
): boolean {
  const requireNonEmpty = opts.requireNonEmpty ?? true;
  const normalizedPred = normalizePhrase(prediction, opts);
  const answerPhrases = splitPhrases(answer, {
    ...opts,
    separators: opts.separators ?? DEFAULT_SEPARATORS,
  });
  if (requireNonEmpty && (!normalizedPred || answerPhrases.length === 0)) {
    return false;
  }
  for (const phrase of new Set(answerPhrases)) {
    const pattern = new RegExp(`\\b${escapeRegex(phrase)}\\b`);
    if (!pattern.test(normalizedPred)) return false;
  }
  return true;
}

export function normPhraseSetMatchOrdered(
  prediction: unknown,
  answer: unknown,
  opts: PhraseSetMatchOptions = {},
): boolean {
  const requireNonEmpty = opts.requireNonEmpty ?? true;
  const normalizedPred = normalizePhrase(prediction, opts);
  const answerPhrases = splitPhrases(answer, {
    ...opts,
    separators: opts.separators ?? DEFAULT_SEPARATORS,
  });
  if (requireNonEmpty && (!normalizedPred || answerPhrases.length === 0)) {
    return false;
  }
  let start = 0;
  for (const phrase of answerPhrases) {
    const pattern = new RegExp(`\\b${escapeRegex(phrase)}\\b`);
    const match = pattern.exec(normalizedPred.slice(start));
    if (!match) return false;
    start += match.index + match[0].length;
  }
  return true;
}

export interface McChoiceMatchOptions {
  stripChars?: string;
  requireNonEmpty?: boolean;
}

export function mcChoiceMatch(
  prediction: unknown,
  answer: unknown,
  opts: McChoiceMatchOptions = {},
): boolean {
  if (prediction === null || prediction === undefined) return false;
  if (answer === null || answer === undefined) return false;
  const predStr =
    typeof prediction === "string" ? prediction : String(prediction);
  const ansStr = typeof answer === "string" ? answer : String(answer);
  const stripChars = opts.stripChars ?? ".";
  const requireNonEmpty = opts.requireNonEmpty ?? true;

  const boxedMatch = predStr.toLowerCase().match(/\\boxed\{([^}]*)\}/);
  let candidate = boxedMatch ? boxedMatch[1] : predStr;
  candidate = candidate.replace(/\b(choice|option)\b/gi, "");
  for (const ch of stripChars) {
    candidate = candidate.split(ch).join("");
  }
  const cleaned = candidate.trim().toUpperCase();
  const expected = ansStr.trim().toUpperCase();
  if (requireNonEmpty && (!cleaned || !expected)) return false;
  return cleaned === expected;
}

const MULTI_SELECT_FILLER_WORDS = new Set([
  "AND",
  "ANSWER",
  "ANSWERS",
  "CHOICE",
  "CHOICES",
  "FINAL",
  "LETTER",
  "LETTERS",
  "OPTION",
  "OPTIONS",
]);

export function extractMultiSelectLetters(text: unknown): string[] {
  if (text === null || text === undefined) return [];
  const s = typeof text === "string" ? text : String(text);
  const chunks = s.toUpperCase().match(/[A-Z]+/g) ?? [];
  const letters: string[] = [];
  for (const chunk of chunks) {
    if (MULTI_SELECT_FILLER_WORDS.has(chunk)) continue;
    for (const ch of chunk) letters.push(ch);
  }
  return letters;
}

export interface McChoiceSetMatchOptions {
  requireNonEmpty?: boolean;
}

export function mcChoiceSetMatch(
  prediction: unknown,
  answer: unknown,
  opts: McChoiceSetMatchOptions = {},
): boolean {
  const requireNonEmpty = opts.requireNonEmpty ?? true;
  const predLetters = extractMultiSelectLetters(prediction);
  const ansLetters = extractMultiSelectLetters(answer);
  if (
    requireNonEmpty &&
    (predLetters.length === 0 || ansLetters.length === 0)
  ) {
    return false;
  }
  const predSet = new Set(predLetters);
  const ansSet = new Set(ansLetters);
  if (predSet.size !== ansSet.size) return false;
  for (const letter of predSet) {
    if (!ansSet.has(letter)) return false;
  }
  return true;
}
