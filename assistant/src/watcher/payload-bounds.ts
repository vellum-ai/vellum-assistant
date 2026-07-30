/**
 * Size bounds for watcher event payloads.
 *
 * Provider payloads are attacker-authorable and structurally arbitrary: a
 * calendar `location`, a Linear `commentBody`, a Gmail `subject`. They are
 * bounded at two distinct points, because the two points protect different
 * things and neither one covers the other.
 *
 * 1. {@link capPayloadForStorage} runs in the engine's Phase 1, before
 *    `JSON.stringify(item.payload)` is written to `watcher_events.payload_json`.
 *    It bounds the stored row, and with it the `watcher_list` / `watcher_digest`
 *    responses that return `payloadJson` verbatim.
 * 2. {@link capPayloadForRender} runs in Phase 2, when the stored row is
 *    rendered into the `<external_content>` fence the model reads. It bounds
 *    what reaches model context.
 *
 * The render bound is deliberately much tighter than the storage bound, so it
 * cannot simply be folded into it: a row we are happy to keep on disk is still
 * far more than we want to spend on one event in a prompt.
 */

import { escapeContentBoundaries } from "../security/untrusted-content.js";
import { truncate } from "../util/truncate.js";
import {
  WATCHER_PAYLOAD_FIELD_COUNT_MAX,
  WATCHER_PAYLOAD_KEY_MAX_CHARS,
  WATCHER_PAYLOAD_NESTING_MAX_DEPTH,
  WATCHER_PAYLOAD_TEXT_MAX_CHARS,
} from "./constants.js";

/** Marker left in place of content dropped by a count or depth cap. */
const ELIDED = "[...elided]";

/**
 * Cap every string in a provider payload before it is serialized and stored.
 *
 * Walks the whole structure rather than naming fields, because the fields that
 * need bounding differ per provider and a per-field list is one more thing six
 * providers have to remember. Strings are truncated, arrays and objects are
 * bounded by element count, and nesting is bounded by depth, so the serialized
 * result is bounded by the shape of the caps rather than by the provider's
 * good behaviour.
 *
 * Structure is preserved: this shortens values, it never changes their types,
 * so downstream readers of `payload_json` keep working. `sequence/reply-matcher.ts`
 * reads `payload.from` and `payload.threadId`, both far under the cap.
 */
export function capPayloadForStorage(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    return truncate(value, WATCHER_PAYLOAD_TEXT_MAX_CHARS);
  }

  if (value === null || typeof value !== "object") {
    // Numbers, booleans, undefined. A JSON number is at most a couple dozen
    // characters, so these carry no flooding risk.
    return value;
  }

  if (depth >= WATCHER_PAYLOAD_NESTING_MAX_DEPTH) {
    return ELIDED;
  }

  if (Array.isArray(value)) {
    const kept = value
      .slice(0, WATCHER_PAYLOAD_FIELD_COUNT_MAX)
      .map((entry) => capPayloadForStorage(entry, depth + 1));
    if (value.length > WATCHER_PAYLOAD_FIELD_COUNT_MAX) {
      kept.push(
        `${ELIDED} ${value.length - WATCHER_PAYLOAD_FIELD_COUNT_MAX} more`,
      );
    }
    return kept;
  }

  const capped: Record<string, unknown> = {};
  let seen = 0;
  for (const [key, entry] of Object.entries(value)) {
    if (seen >= WATCHER_PAYLOAD_FIELD_COUNT_MAX) {
      capped[ELIDED] = `${Object.keys(value).length - seen} more field(s)`;
      break;
    }
    capped[truncate(key, WATCHER_PAYLOAD_KEY_MAX_CHARS)] = capPayloadForStorage(
      entry,
      depth + 1,
    );
    seen++;
  }
  return capped;
}

/** Cost in characters of an entry once serialized into a JSON object body. */
function entryCost(key: string, serializedValue: string): number {
  // `"key":value,`
  return JSON.stringify(key).length + 1 + serializedValue.length + 1;
}

/**
 * Serialize `text` as a JSON string of at most `limit` characters.
 *
 * Allowances here are denominated in serialized characters, and JSON escaping
 * expands as it serializes: a quote or a backslash doubles, a control character
 * becomes six. So the cut has to be chosen against the serialized length, not
 * the raw one, and it cannot be derived from the overshoot either, since the
 * expansion is spread unevenly through the text. Search for the longest prefix
 * that fits instead: serialized length is non-decreasing in prefix length, so
 * the fit is a step function and binary search lands exactly on the step.
 *
 * A field whose text is entirely escapes keeps proportionally less of itself
 * than a plain one. That is the honest outcome: what the fence budget spends is
 * what the model actually reads, and an escape costs what it costs.
 */
function serializeWithinLimit(text: string, limit: number): string {
  const full = JSON.stringify(text);
  if (full.length <= limit) {
    return full;
  }

  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (JSON.stringify(truncate(text, mid)).length <= limit) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  // `""` at minimum, which can exceed a limit below 2. The caller's backstop
  // covers that; a budget that tight has no room for the field either way.
  return JSON.stringify(truncate(text, low));
}

/**
 * Share `budget` across `entries` so no entry can starve another.
 *
 * Repeatedly hands every unsatisfied entry an equal slice of what is left; any
 * entry that fits inside its slice takes only what it needs and returns the
 * rest to the pool, which is then reshared among the entries still over. The
 * result is that a field is only ever truncated when the payload genuinely has
 * no room for it, never merely because a bigger field was serialized first.
 *
 * Returns the per-key character allowance for each entry's serialized value.
 */
function shareBudget(
  entries: ReadonlyArray<{ key: string; serialized: string }>,
  budget: number,
): Map<string, number> {
  const allowance = new Map<string, number>();
  let remaining = budget;
  let unsatisfied = entries;

  while (unsatisfied.length > 0) {
    const share = Math.floor(remaining / unsatisfied.length);
    const fits = unsatisfied.filter(
      (e) => entryCost(e.key, e.serialized) <= share,
    );

    if (fits.length === 0) {
      // Nothing else fits in its share, so every remaining entry is truncated
      // to it. This is the only path that loses content, and it loses the same
      // proportion from each entry rather than all of it from the last ones.
      for (const entry of unsatisfied) {
        const overhead = entryCost(entry.key, "");
        allowance.set(entry.key, Math.max(0, share - overhead));
      }
      return allowance;
    }

    for (const entry of fits) {
      allowance.set(entry.key, entry.serialized.length);
      remaining -= entryCost(entry.key, entry.serialized);
    }
    const satisfied = new Set(fits.map((e) => e.key));
    unsatisfied = unsatisfied.filter((e) => !satisfied.has(e.key));
  }

  return allowance;
}

/**
 * Cap a stored `payload_json` to `budget` characters for rendering, field by field.
 *
 * Truncating the serialized blob instead would make survival a function of key
 * order: one oversized early field (an attacker-supplied calendar `location`,
 * say) consumes the whole budget and every field after it disappears before the
 * model sees it, while the engine still marks the event `silent`. Sharing the
 * budget across fields removes the ordering dependency entirely.
 *
 * Values are escaped before they are measured, so the caps bound the string as
 * it will appear inside the fence. Escaping is idempotent, so the pass
 * `wrapUntrustedContent` runs over the assembled block is a no-op.
 *
 * A payload that is not a JSON object (unparseable, or an array or scalar at
 * the top level) has no fields to share across, so it falls back to a plain
 * truncation of the escaped text.
 */
export function capPayloadForRender(
  payloadJson: string,
  budget: number,
): string {
  const fallback = () => truncate(escapeContentBoundaries(payloadJson), budget);

  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson);
  } catch {
    return fallback();
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return fallback();
  }

  const entries: Array<{ key: string; serialized: string; raw: unknown }> = [];
  let seen = 0;
  for (const [rawKey, value] of Object.entries(parsed)) {
    if (seen >= WATCHER_PAYLOAD_FIELD_COUNT_MAX) {
      break;
    }
    // Keys are provider-authored in practice, but this payload was parsed back
    // out of the database, so treat them with the same suspicion as values.
    const key = truncate(
      escapeContentBoundaries(rawKey),
      WATCHER_PAYLOAD_KEY_MAX_CHARS,
    );
    entries.push({
      key,
      serialized: JSON.stringify(escapeStrings(value)),
      raw: value,
    });
    seen++;
  }

  // Reserve the enclosing braces, plus room for the trailing-comma slack that
  // `entryCost` charges to the final entry.
  const allowance = shareBudget(entries, Math.max(0, budget - 4));

  const parts: string[] = [];
  for (const entry of entries) {
    const limit = allowance.get(entry.key) ?? 0;
    const serialized =
      entry.serialized.length <= limit
        ? entry.serialized
        : // Over its allowance: keep the value as a truncated JSON *string* so
          // the rendered payload stays parseable, rather than emitting a value
          // cut off mid-literal.
          serializeWithinLimit(stringify(entry.raw), limit);
    parts.push(`${JSON.stringify(entry.key)}:${serialized}`);
  }

  // Backstop. The arithmetic above is bounded by construction and every value
  // is measured in serialized characters, so this should never bite; the fence
  // budget is derived from this ceiling, so enforce it rather than trust it.
  // Reaching it costs parseability, which is the signal a test would catch.
  return truncate(`{${parts.join(",")}}`, budget);
}

/** Serialize a value to the text used when it has to be truncated. */
function stringify(value: unknown): string {
  const escaped = escapeStrings(value);
  return typeof escaped === "string" ? escaped : JSON.stringify(escaped);
}

/** Escape fence-boundary sequences in every string within a value. */
function escapeStrings(value: unknown): unknown {
  if (typeof value === "string") {
    return escapeContentBoundaries(value);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(escapeStrings);
  }
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    out[escapeContentBoundaries(key)] = escapeStrings(entry);
  }
  return out;
}
