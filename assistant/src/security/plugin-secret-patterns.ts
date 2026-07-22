/**
 * Runtime registry for plugin-declared credential key patterns.
 *
 * Third-party plugins declare the prefix shape of their API keys (e.g.
 * `virlo_tkn_[A-Za-z0-9_-]{20,}`) so that ingress blocking, tool output
 * scanning, and log redaction can detect keys the static `PREFIX_PATTERNS`
 * list cannot know about. Registrations are keyed by plugin name and flow
 * through {@link registerPluginSecretPatterns} /
 * {@link unregisterPluginSecretPatterns}; consumers read the memoized union
 * via {@link getPluginSecretPatterns} and wrap their derived
 * (compiled/flagged) arrays in {@link memoizePluginPatternDerivation}, which
 * invalidates on the union's array identity — every mutation produces a new
 * union array.
 *
 * **Import-light invariant**: this module may import only `secret-patterns.ts`
 * types and `re2js` — no logger, no config, no `plugins/` modules. Hot-path
 * consumers (`util/log-redact.ts`, used inside log serializers) import it, so
 * any heavier import risks cycles and import-time side effects on the logging
 * path. Disabled-plugin filtering happens at the plugin-lifecycle layer
 * (register on activate, unregister on deactivate), not at read time.
 *
 * Patterns are validated against a **restricted grammar** rather than trusted
 * as arbitrary regex: bounded length, an anchored literal prefix (so a plugin
 * cannot register an over-broad matcher that redacts everything), no capture
 * groups / backreferences / lookarounds, no alternation (`|` would let a
 * short prefix smuggle in an unrelated over-broad branch), no quantified
 * groups or nested quantifiers (quantifiers may apply only to a single
 * char/class/escape atom, which keeps the accepted grammar linear-time under
 * the **native** engine, not just under RE2), no hex/unicode/control escapes
 * (`\xNN`, `\uNNNN`, `\cX`, `\0` — every allowed escape spans exactly one
 * source atom, which keeps the minimum-match-length arithmetic sound), and a
 * minimum guaranteed match length (so a pattern cannot match short common
 * substrings and mass-redact every message and log line). An additional
 * mandatory `RE2JS.compile` check backstops the structural scan. Only after a pattern passes is it compiled
 * to the native `RegExp` (no flags) that the `SecretPrefixPattern` contract
 * expects — the restricted grammar is what makes the native compile safe.
 */

import { RE2JS } from "re2js";

import type { SecretPrefixPattern } from "./secret-patterns.js";

// ---------------------------------------------------------------------------
// Validation limits
// ---------------------------------------------------------------------------

/**
 * Size and count limits for plugin-declared patterns. Exported as the single
 * source of truth: the manifest shape schema in
 * `plugins/external-plugin-loader.ts` references these same values so the
 * loader's caps cannot drift from the registry's.
 */
export const PLUGIN_SECRET_PATTERN_LIMITS = {
  /** Maximum regex source length a plugin may register. */
  maxSourceLength: 200,
  /** Minimum number of guaranteed literal prefix characters. */
  minLiteralPrefix: 4,
  /** Maximum number of patterns a single plugin may register. */
  maxPatternsPerPlugin: 5,
  /** Maximum label length. */
  maxLabelLength: 40,
  /**
   * Minimum number of characters a pattern is guaranteed to match. Keeps a
   * short pattern (e.g. `http`) from matching common substrings and blocking
   * every chat message / rewriting every log line.
   */
  minGuaranteedMatchLength: 16,
} as const;

export interface PluginSecretPatternInput {
  /** Human-readable label, e.g. "Virlo API Key". 1–40 chars. */
  label: string;
  /** Regex source string (no flags, no delimiters). */
  pattern: string;
}

export interface PluginSecretPatternRejection {
  pattern: string;
  reason: string;
}

export interface RegisterPluginSecretPatternsResult {
  accepted: number;
  rejected: PluginSecretPatternRejection[];
}

// ---------------------------------------------------------------------------
// Validator
// ---------------------------------------------------------------------------

const LITERAL_PREFIX_CHAR = /[A-Za-z0-9_-]/;

/**
 * Number of characters guaranteed to appear literally at the start of a match.
 * Counts a leading run of `[A-Za-z0-9_-]` chars plus escaped dots (`\.`); a
 * bare `.` is a wildcard and terminates the run. If the run is immediately
 * followed by a quantifier (`*`, `?`, `{`), the last literal char may be
 * optional (e.g. `abcd*` only guarantees `abc`), so it is not counted.
 */
function literalPrefixLength(source: string): number {
  let count = 0;
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (LITERAL_PREFIX_CHAR.test(ch)) {
      count++;
      i++;
      continue;
    }
    if (ch === "\\" && source[i + 1] === ".") {
      count++;
      i += 2;
      continue;
    }
    break;
  }
  const next = source[i];
  if (count > 0 && (next === "*" || next === "?" || next === "{")) {
    count--;
  }
  return count;
}

const QUANTIFIER_CHARS = new Set(["?", "*", "+", "{"]);

/** Matches a `{n}` / `{n,}` / `{n,m}` quantifier at the given offset. */
function parseBraceQuantifier(
  source: string,
  start: number,
): { end: number; min: number } | null {
  const match = /^\{(\d+)(?:,\d*)?\}/.exec(source.slice(start));
  if (match === null) {
    return null;
  }
  return { end: start + match[0].length, min: Number(match[1]) };
}

/**
 * Scan for constructs outside the restricted grammar: capture groups (`(` is
 * allowed only as `(?:`), lookarounds/inline flags (any other `(?`),
 * backreferences (`\1`–`\9`), hex/unicode/control escapes (`\xNN`, `\uNNNN`,
 * `\cX`, `\0` — they span multiple source characters per matched character,
 * so {@link minGuaranteedMatchLength} would overcount them; the restricted
 * grammar targets ASCII key prefixes and never needs them), alternation (an
 * unescaped `|` outside a character class — a branch could bypass the
 * literal-prefix requirement, e.g. `virlo|.*`), quantified groups (`)`
 * followed by `?`/`*`/`+`/`{`), and nested quantifiers (a quantifier directly
 * following another, including lazy `+?` forms). Banning quantifiers on
 * anything but a single char/class/escape atom is what makes the accepted
 * grammar linear-time under the native `RegExp` engine — RE2 accepting a
 * pattern says nothing about how the native matcher backtracks on it. Escapes
 * and character classes are tracked so `\(`, `\|`, and `[()|]` are not
 * misread.
 */
function findStructuralIssue(source: string): string | null {
  let inClass = false;
  let prevWasQuantifier = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]!;
    if (ch === "\\") {
      const next = source[i + 1];
      if (next !== undefined && next >= "1" && next <= "9") {
        return "backreferences are not allowed";
      }
      if (next === "x" || next === "u" || next === "c" || next === "0") {
        return "hex/unicode/control escapes are not allowed — use literal characters";
      }
      i++;
      prevWasQuantifier = false;
      continue;
    }
    if (inClass) {
      if (ch === "]") {
        inClass = false;
      }
      continue;
    }
    if (ch === "[") {
      inClass = true;
      prevWasQuantifier = false;
      continue;
    }
    if (ch === "|") {
      return "alternation (|) is not allowed";
    }
    if (ch === "(") {
      if (source[i + 1] !== "?") {
        return "capture groups are not allowed; use (?:...) instead";
      }
      if (!source.startsWith("(?:", i)) {
        return "lookarounds and inline groups other than (?: are not allowed";
      }
      // Consume the whole `(?:` opener so its `?` is not read as a quantifier.
      i += 2;
      prevWasQuantifier = false;
      continue;
    }
    if (ch === ")") {
      const next = source[i + 1];
      if (next !== undefined && QUANTIFIER_CHARS.has(next)) {
        return "quantifiers on groups are not allowed; quantify single characters or character classes instead";
      }
      prevWasQuantifier = false;
      continue;
    }
    if (ch === "?" || ch === "*" || ch === "+") {
      if (prevWasQuantifier) {
        return "nested quantifiers are not allowed";
      }
      prevWasQuantifier = true;
      continue;
    }
    if (ch === "{") {
      const quantifier = parseBraceQuantifier(source, i);
      if (quantifier !== null) {
        if (prevWasQuantifier) {
          return "nested quantifiers are not allowed";
        }
        prevWasQuantifier = true;
        i = quantifier.end - 1;
        continue;
      }
    }
    prevWasQuantifier = false;
  }
  return null;
}

/**
 * Conservative lower bound on the number of characters any match of `source`
 * must span. Assumes the source already passed {@link findStructuralIssue},
 * so there is no alternation, every escape is a two-source-character atom
 * matching exactly one character (multi-character escapes like `\xNN` are
 * structurally rejected), and every quantifier applies to exactly one
 * single-character atom (literal, `.`, escape, or character class): each atom
 * counts 1, `?`/`*` zero out their atom, `+` keeps it at 1, and `{n,...}`
 * multiplies it by `n`. Groups and zero-width assertions count 0.
 */
function minGuaranteedMatchLength(source: string): number {
  let total = 0;
  let lastAtom = 0;
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === "\\") {
      const next = source[i + 1];
      lastAtom = next === "b" || next === "B" ? 0 : 1;
      total += lastAtom;
      i += 2;
      continue;
    }
    if (ch === "[") {
      i++;
      if (source[i] === "^") {
        i++;
      }
      if (source[i] === "]") {
        i++;
      }
      while (i < source.length && source[i] !== "]") {
        i += source[i] === "\\" ? 2 : 1;
      }
      i++;
      lastAtom = 1;
      total += 1;
      continue;
    }
    if (ch === "(") {
      // Structural scan guarantees this is `(?:`.
      i += 3;
      lastAtom = 0;
      continue;
    }
    if (ch === ")" || ch === "^" || ch === "$") {
      i++;
      lastAtom = 0;
      continue;
    }
    if (ch === "?" || ch === "*") {
      total -= lastAtom;
      lastAtom = 0;
      i++;
      continue;
    }
    if (ch === "+") {
      lastAtom = 0;
      i++;
      continue;
    }
    if (ch === "{") {
      const quantifier = parseBraceQuantifier(source, i);
      if (quantifier !== null) {
        total += lastAtom * (quantifier.min - 1);
        lastAtom = 0;
        i = quantifier.end;
        continue;
      }
    }
    // Literal char or `.` wildcard — both span exactly one character.
    lastAtom = 1;
    total += 1;
    i++;
  }
  return total;
}

/**
 * Validate one pattern against the restricted grammar. Returns the compiled
 * native `RegExp` on success, or a rejection reason. Never throws.
 */
function validatePattern(
  input: PluginSecretPatternInput,
): { ok: true; regex: RegExp } | { ok: false; reason: string } {
  const limits = PLUGIN_SECRET_PATTERN_LIMITS;
  const reject = (reason: string) => ({ ok: false as const, reason });
  if (typeof input.label !== "string" || input.label.length < 1) {
    return reject("label must be a non-empty string");
  }
  if (input.label.length > limits.maxLabelLength) {
    return reject(`label exceeds ${limits.maxLabelLength} characters`);
  }
  const source = input.pattern;
  if (typeof source !== "string" || source.length === 0) {
    return reject("pattern must be a non-empty string");
  }
  if (source.length > limits.maxSourceLength) {
    return reject(`pattern exceeds ${limits.maxSourceLength} characters`);
  }
  if (literalPrefixLength(source) < limits.minLiteralPrefix) {
    return reject(
      `pattern must start with at least ${limits.minLiteralPrefix} literal characters from [A-Za-z0-9_.-] (a distinctive key prefix)`,
    );
  }
  const structuralIssue = findStructuralIssue(source);
  if (structuralIssue !== null) {
    return reject(structuralIssue);
  }
  if (minGuaranteedMatchLength(source) < limits.minGuaranteedMatchLength) {
    return reject(
      `pattern must be guaranteed to match at least ${limits.minGuaranteedMatchLength} characters (short patterns over-match ordinary text)`,
    );
  }
  // RE2 compile guarantees linear-time matching semantics and structurally
  // rejects anything the scans above missed (it has no backtracking, no
  // backreferences, no lookarounds).
  try {
    RE2JS.compile(source);
  } catch (err) {
    return reject(
      `pattern is not a valid RE2 regex: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  try {
    return { ok: true, regex: new RegExp(source) };
  } catch (err) {
    return reject(
      `pattern is not a valid regex: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/** Accepted patterns keyed by plugin name, labels already namespaced. */
const patternsByPlugin = new Map<string, SecretPrefixPattern[]>();

/**
 * Memoized flattened union; invalidated (set to null) on every mutation so
 * the next read builds a new array. The union's array identity is the
 * registry's change signal — {@link memoizePluginPatternDerivation} keys off
 * it.
 */
let cachedUnion: SecretPrefixPattern[] | null = null;

/**
 * Register the credential key patterns declared by `pluginName`, replacing any
 * prior set for that plugin. Each pattern is validated independently; invalid
 * ones are rejected with a reason (never thrown) and valid ones are stored
 * with their label namespaced as `<label> (plugin:<name>)`. At most
 * {@link PLUGIN_SECRET_PATTERN_LIMITS.maxPatternsPerPlugin} patterns are
 * accepted per plugin — the excess is rejected.
 */
export function registerPluginSecretPatterns(
  pluginName: string,
  patterns: ReadonlyArray<PluginSecretPatternInput>,
): RegisterPluginSecretPatternsResult {
  const accepted: SecretPrefixPattern[] = [];
  const rejected: PluginSecretPatternRejection[] = [];
  for (const input of patterns) {
    if (accepted.length >= PLUGIN_SECRET_PATTERN_LIMITS.maxPatternsPerPlugin) {
      rejected.push({
        pattern: String(input.pattern),
        reason: `per-plugin limit of ${PLUGIN_SECRET_PATTERN_LIMITS.maxPatternsPerPlugin} patterns exceeded`,
      });
      continue;
    }
    const result = validatePattern(input);
    if (!result.ok) {
      rejected.push({ pattern: String(input.pattern), reason: result.reason });
      continue;
    }
    accepted.push({
      label: `${input.label} (plugin:${pluginName})`,
      regex: result.regex,
    });
  }
  patternsByPlugin.set(pluginName, accepted);
  cachedUnion = null;
  return { accepted: accepted.length, rejected };
}

/**
 * Remove the patterns declared by `pluginName`. No-op (the memoized union
 * keeps its identity) when the plugin never registered, so it is safe to call
 * on every teardown path.
 */
export function unregisterPluginSecretPatterns(pluginName: string): void {
  if (patternsByPlugin.delete(pluginName)) {
    cachedUnion = null;
  }
}

/**
 * The flattened union of every registered plugin's accepted patterns.
 * Memoized: the same array reference is returned until a mutation invalidates
 * it, so hot-path consumers can cheaply detect change by reference (see
 * {@link memoizePluginPatternDerivation}).
 */
export function getPluginSecretPatterns(): SecretPrefixPattern[] {
  if (cachedUnion === null) {
    const union: SecretPrefixPattern[] = [];
    for (const patterns of patternsByPlugin.values()) {
      union.push(...patterns);
    }
    cachedUnion = union;
  }
  return cachedUnion;
}

/**
 * Memoize a consumer's derivation of the plugin-pattern union. `derive` runs
 * only when the union's identity changes (any register/unregister/reset
 * produces a new array), so the steady-state cost per call is one reference
 * compare.
 */
export function memoizePluginPatternDerivation<T>(
  derive: (patterns: SecretPrefixPattern[]) => T,
): () => T {
  let cached: { union: SecretPrefixPattern[]; value: T } | null = null;
  return () => {
    const union = getPluginSecretPatterns();
    if (cached === null || cached.union !== union) {
      cached = { union, value: derive(union) };
    }
    return cached.value;
  };
}

/** Drop every registration. Exposed for test isolation. */
export function resetPluginSecretPatternsForTests(): void {
  patternsByPlugin.clear();
  cachedUnion = null;
}
