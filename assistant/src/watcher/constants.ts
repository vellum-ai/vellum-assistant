/** Default poll interval for watchers (60 seconds). */
export const DEFAULT_POLL_INTERVAL_MS = 60_000;
/** Disable watcher after this many consecutive errors. */
export const MAX_CONSECUTIVE_ERRORS = 5;
/**
 * Hard timeout for a single watcher's event-processing background job.
 * Mirrors the order of magnitude used by sibling background producers
 * (filing: 15min, heartbeat: 30min) — chosen to keep a wedged tick from
 * blocking subsequent watchers indefinitely.
 */
export const WATCHER_JOB_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * Per-event caps applied before an event is rendered into the `<external_content>`
 * fence the LLM sees.
 *
 * `security/AGENTS.md` requires every untrusted string to be bounded *inside* the
 * fence budget, not just the obvious one: an unbounded field that renders early
 * can otherwise consume the whole budget and truncate away the events after it.
 * Provider payloads have no length ceiling of their own (a Linear comment body or
 * a calendar description is arbitrary-length), so the ceiling is imposed here.
 *
 * These are deliberately generous: Gmail snippets (~200 chars) and Outlook
 * `bodyPreview` (~255) never reach them; they bite only on genuinely long free
 * text, where truncation is preferable to letting one event crowd out the rest.
 */
export const WATCHER_EVENT_SUMMARY_MAX_CHARS = 300;
export const WATCHER_EVENT_PAYLOAD_MAX_CHARS = 4_000;

/**
 * Cap a provider applies to an arbitrary-length free-text payload field before
 * returning the item, i.e. at the source.
 *
 * The render caps above bound what reaches the model, but they run in the
 * engine's Phase 2, after Phase 1 has already written
 * `JSON.stringify(item.payload)` into `watcher_events.payload_json`. So they do
 * not bound the stored row, and they do not bound the `watcher_list` /
 * `watcher_digest` route responses, which return `payloadJson` verbatim. A
 * field with no ceiling of its own has to be capped by the provider that reads
 * it, per the "cap each such string at the source" rule in `security/AGENTS.md`.
 *
 * 5,000 is generous enough that real events keep their full text (Gmail
 * snippets ~200 chars, Outlook `bodyPreview` ~255) and matches the bound the
 * calendar description carried before its per-field fence was folded into the
 * engine's single outer envelope. Google documents no ceiling of its own on
 * `description` (see `eventToItem`), so this is the only bound on it.
 */
export const WATCHER_PAYLOAD_TEXT_MAX_CHARS = 5_000;

/**
 * Bounds on payload *shape*, applied alongside the text cap above.
 *
 * A payload with no long string in it can still be unbounded: a thousand short
 * fields, a long array of attendees, or a deeply nested object all serialize
 * large. Providers return whatever the upstream API sends, so the shape is as
 * attacker-influenced as the text, and capping only string length would leave
 * the obvious flood open.
 *
 * The values are far above any real payload. The largest first-party payload is
 * the calendar one at 10 fields, and a 100-person meeting is an unusually large
 * attendee list.
 */
export const WATCHER_PAYLOAD_FIELD_COUNT_MAX = 100;
export const WATCHER_PAYLOAD_KEY_MAX_CHARS = 100;
export const WATCHER_PAYLOAD_NESTING_MAX_DEPTH = 6;

/**
 * Ceiling on one serialized `watcher_events.payload_json` row.
 *
 * The caps above bound each node on its own, and per-node bounds multiply: at
 * their maximum, 100 fields of 100 strings at the text cap, they permit a
 * 50,089,791-character row. So the row needs a ceiling of its own, and the caps
 * above become the shape within it rather than the whole bound.
 *
 * 64,000 is roughly four times the largest realistic row (a calendar event with
 * an oversized description and location plus a 100-person attendee list
 * measures 16,347), so nothing real is touched, and it is small enough that a
 * watcher cannot turn one event into a database problem.
 */
export const WATCHER_PAYLOAD_ROW_MAX_CHARS = 64_000;
