/**
 * Runtime registry for plugin-declared credential key patterns.
 *
 * Third-party plugins declare the prefix shape of their API keys (e.g.
 * `virlo_tkn_[A-Za-z0-9_-]{20,}`) so that ingress blocking, tool output
 * scanning, and log redaction can detect keys the static `PREFIX_PATTERNS`
 * list cannot know about. Registrations are keyed by plugin name and flow
 * through {@link registerPluginSecretPatterns} /
 * {@link unregisterPluginSecretPatterns}; consumers read the memoized union
 * via {@link getPluginSecretPatterns} and use
 * {@link getPluginSecretPatternsVersion} to invalidate their own derived
 * (compiled/flagged) arrays.
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
 * groups / backreferences / lookarounds, and a mandatory `RE2JS.compile`
 * check that structurally guarantees linear-time matching. Only after a
 * pattern passes is it compiled to the native `RegExp` (no flags) that the
 * `SecretPrefixPattern` contract expects — the restricted grammar is what
 * makes the native compile safe.
 */

import { RE2JS } from "re2js";

import type { SecretPrefixPattern } from "./secret-patterns.js";

// ---------------------------------------------------------------------------
// Validation limits
// ---------------------------------------------------------------------------

/** Maximum regex source length a plugin may register. */
const MAX_SOURCE_LENGTH = 200;

/** Minimum number of guaranteed literal prefix characters. */
const MIN_LITERAL_PREFIX = 4;

/** Maximum number of patterns a single plugin may register. */
const MAX_PATTERNS_PER_PLUGIN = 5;

const MAX_LABEL_LENGTH = 40;

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

/**
 * Scan for constructs outside the restricted grammar: capture groups (`(` is
 * allowed only as `(?:`), lookarounds/inline flags (any other `(?`), and
 * backreferences (`\1`–`\9`). Escapes and character classes are tracked so
 * `\(` and `[()]` are not misread as groups.
 */
function findStructuralIssue(source: string): string | null {
  let inClass = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]!;
    if (ch === "\\") {
      const next = source[i + 1];
      if (next !== undefined && next >= "1" && next <= "9") {
        return "backreferences are not allowed";
      }
      i++;
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
      continue;
    }
    if (ch === "(") {
      if (source.startsWith("(?:", i)) {
        continue;
      }
      if (source[i + 1] === "?") {
        return "lookarounds and inline groups other than (?: are not allowed";
      }
      return "capture groups are not allowed; use (?:...) instead";
    }
  }
  return null;
}

/**
 * Validate one pattern against the restricted grammar. Returns the compiled
 * native `RegExp` on success, or a rejection reason. Never throws.
 */
function validatePattern(
  input: PluginSecretPatternInput,
): { ok: true; regex: RegExp } | { ok: false; reason: string } {
  const reject = (reason: string) => ({ ok: false as const, reason });
  if (typeof input.label !== "string" || input.label.length < 1) {
    return reject("label must be a non-empty string");
  }
  if (input.label.length > MAX_LABEL_LENGTH) {
    return reject(`label exceeds ${MAX_LABEL_LENGTH} characters`);
  }
  const source = input.pattern;
  if (typeof source !== "string" || source.length === 0) {
    return reject("pattern must be a non-empty string");
  }
  if (source.length > MAX_SOURCE_LENGTH) {
    return reject(`pattern exceeds ${MAX_SOURCE_LENGTH} characters`);
  }
  if (literalPrefixLength(source) < MIN_LITERAL_PREFIX) {
    return reject(
      `pattern must start with at least ${MIN_LITERAL_PREFIX} literal characters from [A-Za-z0-9_.-] (a distinctive key prefix)`,
    );
  }
  const structuralIssue = findStructuralIssue(source);
  if (structuralIssue !== null) {
    return reject(structuralIssue);
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

/** Bumped on every mutation; consumers memoize derived arrays against it. */
let version = 0;

/** Memoized flattened union; invalidated on every mutation. */
let cachedUnion: SecretPrefixPattern[] | null = null;

/**
 * Register the credential key patterns declared by `pluginName`, replacing any
 * prior set for that plugin. Each pattern is validated independently; invalid
 * ones are rejected with a reason (never thrown) and valid ones are stored
 * with their label namespaced as `<label> (plugin:<name>)`. At most
 * {@link MAX_PATTERNS_PER_PLUGIN} patterns are accepted per plugin — the
 * excess is rejected.
 */
export function registerPluginSecretPatterns(
  pluginName: string,
  patterns: ReadonlyArray<PluginSecretPatternInput>,
): RegisterPluginSecretPatternsResult {
  const accepted: SecretPrefixPattern[] = [];
  const rejected: PluginSecretPatternRejection[] = [];
  for (const input of patterns) {
    if (accepted.length >= MAX_PATTERNS_PER_PLUGIN) {
      rejected.push({
        pattern: String(input.pattern),
        reason: `per-plugin limit of ${MAX_PATTERNS_PER_PLUGIN} patterns exceeded`,
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
  version++;
  cachedUnion = null;
  return { accepted: accepted.length, rejected };
}

/**
 * Remove the patterns declared by `pluginName`. No-op (no version bump) when
 * the plugin never registered, so it is safe to call on every teardown path.
 */
export function unregisterPluginSecretPatterns(pluginName: string): void {
  if (patternsByPlugin.delete(pluginName)) {
    version++;
    cachedUnion = null;
  }
}

/**
 * The flattened union of every registered plugin's accepted patterns.
 * Memoized: the same array reference is returned until a mutation bumps the
 * version, so hot-path consumers can cheaply detect change by reference or
 * via {@link getPluginSecretPatternsVersion}.
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
 * Monotonic mutation counter. Consumers that derive per-call-site compiled
 * arrays from the union should rebuild only when this value changes.
 */
export function getPluginSecretPatternsVersion(): number {
  return version;
}

/** Drop every registration and reset the version. Exposed for test isolation. */
export function resetPluginSecretPatternsForTests(): void {
  patternsByPlugin.clear();
  version = 0;
  cachedUnion = null;
}
