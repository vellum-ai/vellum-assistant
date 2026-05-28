/**
 * Text normalization primitives used by the deterministic evaluators.
 *
 * Mirrors `normalize_phrase` and `split_phrases` from V2's
 * `evaluation/qa_eval_metrics.py`. Defaults match the Python version:
 * lowercase, hyphen/underscore → space, comma/semicolon → space, strip
 * non-word characters, collapse runs of whitespace.
 */

export const DEFAULT_SEPARATORS: ReadonlyArray<string> = [",", ";"];

export interface NormalizeOptions {
  lower?: boolean;
  normalizeHyphen?: boolean;
  stripPunct?: boolean;
}

export interface SplitOptions extends NormalizeOptions {
  separators?: ReadonlyArray<string>;
}

export function normalizePhrase(
  text: unknown,
  opts: NormalizeOptions = {},
): string {
  if (text === null || text === undefined) return "";
  let s = typeof text === "string" ? text : String(text);
  const lower = opts.lower ?? true;
  const normalizeHyphen = opts.normalizeHyphen ?? true;
  const stripPunct = opts.stripPunct ?? true;
  if (lower) s = s.toLowerCase();
  if (normalizeHyphen) s = s.replace(/[-_]/g, " ");
  s = s.replace(/[,;]/g, " ");
  if (stripPunct) {
    // Python re.sub(r"[^\w\s]", "", text). JS \w is [A-Za-z0-9_], same ASCII
    // semantics as Python's default str regex.
    s = s.replace(/[^\w\s]/g, "");
  }
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

export function splitPhrases(text: unknown, opts: SplitOptions = {}): string[] {
  if (text === null || text === undefined) return [];
  const separators = opts.separators ?? DEFAULT_SEPARATORS;
  if (separators.length === 0) {
    const normalized = normalizePhrase(text, opts);
    return normalized ? [normalized] : [];
  }
  const s = typeof text === "string" ? text : String(text);
  const pattern = new RegExp(separators.map(escapeRegex).join("|"));
  const parts = s.split(pattern);
  return parts
    .map((part) => normalizePhrase(part, opts))
    .filter((part) => part.length > 0);
}

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
