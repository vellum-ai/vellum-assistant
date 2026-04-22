/**
 * UTF-16 surrogate-pair-safe string utilities.
 *
 * JavaScript strings are UTF-16. Code points above the BMP (emoji, many CJK
 * characters, mathematical symbols, etc.) are stored as surrogate pairs — a
 * high surrogate (U+D800–U+DBFF) followed by a low surrogate (U+DC00–U+DFFF).
 * `String.prototype.slice` operates on code units, not code points, so naive
 * slicing can split a pair and leave an orphaned surrogate. Orphaned
 * surrogates are invalid UTF-16 and cause `JSON.stringify` output to be
 * rejected by strict JSON parsers (including Anthropic's API).
 */

const HIGH_SURROGATE_START = 0xd800;
const HIGH_SURROGATE_END = 0xdbff;
const LOW_SURROGATE_START = 0xdc00;
const LOW_SURROGATE_END = 0xdfff;
const REPLACEMENT_CHAR = "\ufffd";

function isHighSurrogate(code: number): boolean {
  return code >= HIGH_SURROGATE_START && code <= HIGH_SURROGATE_END;
}

function isLowSurrogate(code: number): boolean {
  return code >= LOW_SURROGATE_START && code <= LOW_SURROGATE_END;
}

/**
 * Slice a string like `String.prototype.slice`, but never cut a UTF-16
 * surrogate pair in half.
 *
 * If the character at `end - 1` is a high surrogate *and* there is more of
 * the string beyond `end` (so cutting would actually orphan it), `end` is
 * decremented by one.
 *
 * If the character at `start` is a low surrogate *and* `start > 0` (so we
 * would be starting mid-pair), `start` is incremented by one.
 *
 * When `end === str.length` we do not touch a trailing high surrogate: if it
 * was already orphaned upstream, repairing it here would silently mutate
 * content. That is the sanitizer's job, not this function's.
 */
export function safeStringSlice(
  str: string,
  start = 0,
  end: number = str.length,
): string {
  let safeStart = Math.max(0, Math.min(str.length, start));
  let safeEnd = Math.max(safeStart, Math.min(str.length, end));

  if (safeEnd < str.length && safeEnd > safeStart) {
    const lastCode = str.charCodeAt(safeEnd - 1);
    if (isHighSurrogate(lastCode)) {
      safeEnd--;
    }
  }

  if (safeStart > 0 && safeStart < str.length) {
    const firstCode = str.charCodeAt(safeStart);
    if (isLowSurrogate(firstCode)) {
      safeStart++;
      if (safeStart > safeEnd) safeEnd = safeStart;
    }
  }

  return str.slice(safeStart, safeEnd);
}

/**
 * Replace every orphaned UTF-16 surrogate in `str` with U+FFFD
 * (REPLACEMENT CHARACTER).
 *
 * Returns the original reference if no changes were needed, so callers can
 * check `result === input` as a cheap "nothing was stripped" signal.
 */
export function stripOrphanedSurrogates(str: string): string {
  let needsFix = false;
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (isHighSurrogate(code)) {
      const next = i + 1 < str.length ? str.charCodeAt(i + 1) : 0;
      if (!isLowSurrogate(next)) {
        needsFix = true;
        break;
      }
      i++;
    } else if (isLowSurrogate(code)) {
      needsFix = true;
      break;
    }
  }
  if (!needsFix) return str;

  let out = "";
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (isHighSurrogate(code)) {
      const next = i + 1 < str.length ? str.charCodeAt(i + 1) : 0;
      if (isLowSurrogate(next)) {
        out += str[i] + str[i + 1];
        i++;
      } else {
        out += REPLACEMENT_CHAR;
      }
    } else if (isLowSurrogate(code)) {
      out += REPLACEMENT_CHAR;
    } else {
      out += str[i];
    }
  }
  return out;
}

/**
 * Result of a deep sanitization walk. If `changed` is false the caller should
 * use the original reference it passed in; `value` is only meaningful when
 * `changed` is true.
 */
export interface DeepSanitizeResult<T> {
  value: T;
  changed: boolean;
  /** Count of string values that had at least one orphan replaced. */
  fixedStringCount: number;
}

/**
 * Recursively walk arrays and plain objects, replacing orphaned surrogates in
 * every string value. Non-plain objects (class instances, Date, Buffer, Map,
 * Set, etc.) and non-string primitives are returned unchanged.
 *
 * On the happy path (no orphans found anywhere in the tree) the original
 * reference is returned verbatim — no copies are made.
 */
export function stripOrphanedSurrogatesDeep<T>(
  input: T,
): DeepSanitizeResult<T> {
  let fixedStringCount = 0;

  const walk = (value: unknown): { value: unknown; changed: boolean } => {
    if (typeof value === "string") {
      const cleaned = stripOrphanedSurrogates(value);
      if (cleaned !== value) {
        fixedStringCount++;
        return { value: cleaned, changed: true };
      }
      return { value, changed: false };
    }

    if (Array.isArray(value)) {
      let next: unknown[] | null = null;
      for (let i = 0; i < value.length; i++) {
        const result = walk(value[i]);
        if (result.changed && next === null) {
          next = [];
          for (let j = 0; j < i; j++) {
            next.push(value[j]);
          }
        }
        if (next !== null) {
          next.push(result.value);
        }
      }
      return next !== null
        ? { value: next, changed: true }
        : { value, changed: false };
    }

    if (value != null && typeof value === "object") {
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        return { value, changed: false };
      }
      const source = value as Record<string, unknown>;
      const keys = Object.keys(source);
      let next: Record<string, unknown> | null = null;
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i]!;
        const result = walk(source[key]);
        if (result.changed && next === null) {
          next = {};
          for (let j = 0; j < i; j++) {
            const priorKey = keys[j]!;
            next[priorKey] = source[priorKey];
          }
        }
        if (next !== null) {
          next[key] = result.value;
        }
      }
      return next !== null
        ? { value: next, changed: true }
        : { value, changed: false };
    }

    return { value, changed: false };
  };

  const result = walk(input);
  return {
    value: result.value as T,
    changed: result.changed,
    fixedStringCount,
  };
}
