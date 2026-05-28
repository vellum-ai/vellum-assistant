/**
 * Parser for V2's `eval_function` spec strings.
 *
 * Spec format (from `parse_eval_function_spec` in V2's
 * `evaluation/qa_eval_metrics.py`):
 *
 *     "<name>|<key1>=<value1>|<key2>=<value2>|..."
 *
 * Where `<name>` is the eval function identifier (in V2's snake_case) and
 * each `<keyN>=<valueN>` is a kwarg override. We keep `name` in V2's
 * snake_case so the dispatcher can match it verbatim; we convert kwarg
 * keys to TypeScript-idiomatic camelCase so callers can spread them
 * alongside other camelCase options.
 */

export interface ParsedEvalSpec {
  /** Function identifier in V2 snake_case (e.g. `norm_phrase_set_match`). */
  name: string;
  /** Kwargs from the spec string, converted to camelCase. */
  kwargs: Record<string, unknown>;
}

export function parseEvalFunctionSpec(spec: unknown): ParsedEvalSpec {
  if (typeof spec !== "string" || spec.length === 0) {
    throw new Error("eval function spec must be a non-empty string.");
  }
  const parts = spec.split("|").map((part) => part.trim());
  const name = parts[0];
  if (!name) {
    throw new Error("eval function spec missing function name.");
  }
  const kwargs: Record<string, unknown> = {};
  for (const part of parts.slice(1)) {
    if (!part) continue;
    const eq = part.indexOf("=");
    if (eq === -1) {
      throw new Error(`Invalid eval function option: ${part}`);
    }
    const rawKey = part.slice(0, eq).trim();
    const rawValue = part.slice(eq + 1).trim();
    if (!rawKey) {
      throw new Error(`Invalid eval function option: ${part}`);
    }
    const camelKey = snakeToCamel(rawKey);
    if (camelKey in kwargs) {
      throw new Error(`Duplicate eval function option: ${rawKey}`);
    }
    kwargs[camelKey] = parseEvalValue(rawKey, rawValue);
  }
  return { name, kwargs };
}

export function parseEvalValue(rawKey: string, value: string): unknown {
  const lowered = value.toLowerCase();
  if (lowered === "true" || lowered === "false") {
    return lowered === "true";
  }
  if (lowered === "none" || lowered === "null") {
    return null;
  }
  if (rawKey === "separators" || rawKey === "separator") {
    if (value.length === 0) return [];
    const stripped = value.trim();
    if (stripped.startsWith("[") && stripped.endsWith("]")) {
      try {
        const parsed = JSON.parse(stripped);
        if (Array.isArray(parsed)) return parsed;
      } catch {
        // Fall through to char split — matches Python behavior when JSON
        // parsing would fail.
      }
    }
    // Mirror Python: split into individual non-whitespace characters.
    return Array.from(value).filter((ch) => !/\s/.test(ch));
  }
  if (/^-?\d+\.\d+$/.test(value)) {
    return Number.parseFloat(value);
  }
  if (/^-?\d+$/.test(value)) {
    return Number.parseInt(value, 10);
  }
  return value;
}

function snakeToCamel(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_, ch: string) => ch.toUpperCase());
}
