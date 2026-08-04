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
  WATCHER_PAYLOAD_ROW_MAX_CHARS,
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
 * Those caps bound each node, and per-node bounds multiply, so the serialized
 * row is bounded separately by {@link WATCHER_PAYLOAD_ROW_MAX_CHARS}.
 *
 * Structure is preserved for any payload under that ceiling: this shortens
 * values, it never changes their types, so downstream readers of `payload_json`
 * keep working. `sequence/reply-matcher.ts` reads `payload.from` and
 * `payload.threadId`, both far under the caps. A payload over the ceiling is
 * reshaped to fit, which can turn a nested object into JSON text.
 */
export function capPayloadForStorage(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const capped = capRecord(payload, 0);
  const serialized = JSON.stringify(capped);
  if (serialized.length <= WATCHER_PAYLOAD_ROW_MAX_CHARS) {
    return capped;
  }

  // Per-node caps multiply, so they bound each field without bounding the row.
  // Only a row that actually exceeds the ceiling is reshaped, which keeps this
  // invisible to every realistic payload: a calendar event with a 100-person
  // attendee list measures 10,499 characters and is returned above untouched.
  //
  // The reshaping is the render pass at the row ceiling, rather than a second
  // copy of the same reasoning: it shares the budget exactly, so short fields
  // keep everything and only the greedy ones are trimmed. It costs fidelity a
  // stored row would otherwise keep (a nested object comes back as JSON text,
  // fence sequences come back escaped), which is the right trade for a payload
  // this far past the ceiling.
  try {
    const bounded: unknown = JSON.parse(
      capPayloadForRender(serialized, WATCHER_PAYLOAD_ROW_MAX_CHARS),
    );
    if (bounded !== null && typeof bounded === "object") {
      return capRecord(bounded, 0);
    }
  } catch {
    // Fall through to the marker.
  }

  return {
    [ELIDED]: `payload exceeded ${WATCHER_PAYLOAD_ROW_MAX_CHARS} characters`,
  };
}

/**
 * Cap one object, returning a record whose top-level shape is earned rather
 * than asserted, so the engine needs no type assertion where provider data
 * crosses into the daemon.
 *
 * Fields are defined rather than assigned. Assignment runs setters, and a
 * payload can carry an own `__proto__` key: `JSON.parse` makes it an own
 * property, but `capped.__proto__ = value` hands it to the prototype setter
 * instead, which drops the field from the serialized row and reparents the
 * object, so a reader such as `sequence/reply-matcher.ts` could then inherit a
 * `from` the provider never set. `defineProperty` keeps it an ordinary field.
 *
 * Keys are truncated, so two long keys can arrive at the same prefix. That is
 * resolved deterministically rather than by last-write-wins, since bounding a
 * payload must not be able to replace one of its fields with another.
 */
function capRecord(value: object, depth: number): Record<string, unknown> {
  const capped: Record<string, unknown> = {};
  const taken = new Set<string>();
  const entries = Object.entries(value);
  const kept = entries.slice(0, WATCHER_PAYLOAD_FIELD_COUNT_MAX);

  for (const [rawKey, entry] of kept) {
    const key = disambiguate(
      truncate(rawKey, WATCHER_PAYLOAD_KEY_MAX_CHARS),
      taken,
    );
    taken.add(key);
    define(capped, key, capValue(entry, depth + 1));
  }

  const dropped = entries.length - kept.length;
  if (dropped > 0) {
    define(capped, disambiguate(ELIDED, taken), `${dropped} more field(s)`);
  }
  return capped;
}

/** Add an own enumerable field, whatever its name. See {@link capRecord}. */
function define(target: Record<string, unknown>, key: string, value: unknown) {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function capValue(value: unknown, depth: number): unknown {
  if (typeof value === "string") {
    return truncate(value, WATCHER_PAYLOAD_TEXT_MAX_CHARS);
  }

  if (value === null || typeof value !== "object") {
    // Numbers, booleans, undefined. A JSON number is at most a couple dozen
    // characters, so these carry no flooding risk on their own.
    return value;
  }

  if (depth >= WATCHER_PAYLOAD_NESTING_MAX_DEPTH) {
    return ELIDED;
  }

  if (Array.isArray(value)) {
    const kept = value
      .slice(0, WATCHER_PAYLOAD_FIELD_COUNT_MAX)
      .map((entry) => capValue(entry, depth + 1));
    if (value.length > WATCHER_PAYLOAD_FIELD_COUNT_MAX) {
      kept.push(
        `${ELIDED} ${value.length - WATCHER_PAYLOAD_FIELD_COUNT_MAX} more`,
      );
    }
    return kept;
  }

  return capRecord(value, depth);
}

/** Cost in characters of an entry once serialized into a JSON object body. */
function entryCost(key: string, serializedValue: string): number {
  // `"key":value,`
  return JSON.stringify(key).length + 1 + serializedValue.length + 1;
}

/** Smallest entry worth rendering: `"k":"v",`. */
const MIN_ENTRY_CHARS = 8;

/** Suffix that keeps two keys distinct when truncation collapses them. */
const KEY_DISAMBIGUATOR = "~";

/**
 * Longest prefix of `text` whose JSON string form fits `limit` characters.
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
function prefixWithinLimit(text: string, limit: number): string {
  // Both bounds here lean on escaping never shrinking a string: its serialized
  // form is at least the text plus two quotes. So text already past the limit
  // needs no measuring, and no prefix longer than the limit can fit either.
  // Searching the whole text instead costs a stringify of it on every step.
  if (text.length + 2 <= limit && JSON.stringify(text).length <= limit) {
    return text;
  }

  let low = 0;
  let high = Math.min(text.length, limit);
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (JSON.stringify(truncate(text, mid)).length <= limit) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  // Empty at minimum, so the JSON form is `""`, which exceeds a limit below 2.
  // `MIN_ENTRY_CHARS` keeps the callers above that.
  return truncate(text, low);
}

/** {@link prefixWithinLimit}, as the JSON string the object body carries. */
function serializeWithinLimit(text: string, limit: number): string {
  return JSON.stringify(prefixWithinLimit(text, limit));
}

/**
 * Share `budget` across entries of the given costs so none can starve another.
 *
 * Repeatedly hands every unsatisfied entry an equal slice of what is left; any
 * entry that fits inside its slice takes only what it needs and returns the
 * rest to the pool, which is then reshared among the entries still over. The
 * result is that a field is only ever truncated when the payload genuinely has
 * no room for it, never merely because a bigger field was serialized first.
 *
 * A cost is the entry's whole serialized width, key included, and allowances
 * come back the same way. Sharing only across values would let keys spend
 * budget nobody accounted for: the storage pass permits 100 keys of 100
 * characters, whose keys alone outrun a 4,000-character render budget.
 *
 * Allowances are returned by index, not keyed by name, since two keys can
 * collide once they are truncated.
 */
function shareBudget(costs: readonly number[], budget: number): number[] {
  const allowance = new Array<number>(costs.length).fill(0);
  let remaining = budget;
  let unsatisfied = costs.map((cost, index) => ({ cost, index }));

  while (unsatisfied.length > 0) {
    const share = Math.floor(remaining / unsatisfied.length);
    const fits = unsatisfied.filter((e) => e.cost <= share);

    if (fits.length === 0) {
      // Nothing else fits in its share, so every remaining entry is truncated
      // to it. This is the only path that loses content, and it loses the same
      // proportion from each entry rather than all of it from the last ones.
      for (const entry of unsatisfied) {
        allowance[entry.index] = share;
      }
      return allowance;
    }

    for (const entry of fits) {
      allowance[entry.index] = entry.cost;
      remaining -= entry.cost;
    }
    const satisfied = new Set(fits.map((e) => e.index));
    unsatisfied = unsatisfied.filter((e) => !satisfied.has(e.index));
  }

  return allowance;
}

/**
 * Render one entry within `allowance` characters, key and value together.
 *
 * The key takes at most half the allowance, so a wide key cannot squeeze its
 * value out of the object entirely, and both sides are measured after JSON
 * escaping rather than before. A key that has to be shortened can collide with
 * one already rendered, which would silently drop a field when the result is
 * parsed, so collisions are disambiguated rather than left to chance.
 */
function renderEntry(
  key: string,
  text: string,
  serialized: string,
  allowance: number,
  taken: Set<string>,
): string {
  const keyJson = JSON.stringify(key);
  const fits = entryCost(key, serialized) <= allowance;

  const keyText = fits
    ? key
    : prefixWithinLimit(key, Math.max(2, Math.floor(allowance / 2)));
  const uniqueKeyText = disambiguate(keyText, taken);
  taken.add(uniqueKeyText);

  const uniqueKeyJson = JSON.stringify(uniqueKeyText);
  if (fits && uniqueKeyJson.length === keyJson.length) {
    return `${uniqueKeyJson}:${serialized}`;
  }

  // Two characters for the colon and the trailing comma `entryCost` charges.
  const valueLimit = Math.max(0, allowance - uniqueKeyJson.length - 2);
  const value =
    serialized.length <= valueLimit
      ? serialized
      : serializeWithinLimit(text, valueLimit);
  return `${uniqueKeyJson}:${value}`;
}

/** Make `key` distinct from everything in `taken`, without growing it. */
function disambiguate(key: string, taken: Set<string>): string {
  if (!taken.has(key)) {
    return key;
  }
  for (let n = 2; ; n++) {
    const suffix = `${KEY_DISAMBIGUATOR}${n}`;
    // Replacing the tail rather than appending keeps the width, and the
    // replacement never escapes, so the serialized key cannot grow either.
    const candidate =
      key.slice(0, Math.max(0, key.length - suffix.length)) + suffix;
    if (!taken.has(candidate)) {
      return candidate;
    }
  }
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

  // Bound the parsed row before walking it. The storage pass bounds what this
  // daemon writes from now on, but this reads rows back, including ones written
  // before that pass existed, so the shape here is whatever a provider once
  // returned. Unbounded nesting would otherwise overflow the stack in the
  // escape walk below and fail the same pending row on every tick.
  const bounded = capRecord(parsed, 0);

  const entries: Array<{ key: string; serialized: string; text: string }> = [];
  for (const [rawKey, value] of Object.entries(bounded)) {
    // Keys are provider-authored in practice, but this payload was parsed back
    // out of the database, so treat them with the same suspicion as values.
    const key = truncate(
      escapeContentBoundaries(rawKey),
      WATCHER_PAYLOAD_KEY_MAX_CHARS,
    );
    // Escape once: the serialized form is what is measured, and the escaped
    // text is what a truncated value is cut from.
    const escaped = escapeStrings(value);
    const serialized = JSON.stringify(escaped);
    entries.push({
      key,
      serialized,
      text: typeof escaped === "string" ? escaped : serialized,
    });
  }

  // A budget can be too small to render every field at any width. Decide that
  // up front, by count, and record it in the payload: dropping fields off the
  // end silently is the failure this function exists to prevent, and it is not
  // improved by happening for a different reason.
  const capacity = Math.floor(Math.max(0, budget - 2) / MIN_ENTRY_CHARS);
  const dropped = Math.max(0, entries.length - capacity);
  const kept =
    dropped > 0 ? entries.slice(0, Math.max(0, capacity - 1)) : entries;
  const marker =
    dropped > 0
      ? `${JSON.stringify(ELIDED)}:${JSON.stringify(`${dropped} more field(s)`)}`
      : "";

  // Two characters for the enclosing braces. Entry costs each carry a trailing
  // comma, which over-charges the last entry by one.
  const allowances = shareBudget(
    kept.map((entry) => entryCost(entry.key, entry.serialized)),
    Math.max(0, budget - 2 - (marker ? marker.length + 1 : 0)),
  );

  const taken = new Set<string>();
  const parts = kept.map((entry, index) =>
    renderEntry(
      entry.key,
      entry.text,
      entry.serialized,
      allowances[index] ?? 0,
      taken,
    ),
  );
  if (marker) {
    parts.push(marker);
  }

  // Backstop. The arithmetic above is bounded by construction and every part is
  // measured in serialized characters, so this should never bite; the fence
  // budget is derived from this ceiling, so enforce it rather than trust it.
  // Reaching it costs parseability, which is what the tests assert on.
  return truncate(`{${parts.join(",")}}`, budget);
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
    define(out, escapeContentBoundaries(key), escapeStrings(entry));
  }
  return out;
}
